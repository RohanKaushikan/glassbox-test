#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getInput, setOutput, setFailed, info, warning, error } from '@actions/core';
import { context, getOctokit } from '@actions/github';

/**
 * GitHub Action wrapper for Glassbox CLI
 * Handles input parsing, CLI execution, result processing, and PR comments
 */

class GlassboxAction {
  constructor() {
    this.inputs = this.parseInputs();
    this.results = null;
    this.octokit = null;
  }

  /**
   * Parse all action inputs with defaults
   */
  parseInputs() {
    return {
      // Test configuration
      testDirectory: getInput('test-directory') || '.glassbox/tests/',
      model: getInput('model') || 'gpt-3.5-turbo',
      outputFormat: getInput('output-format') || 'json',
      timeout: parseInt(getInput('timeout')) || 30000,
      concurrency: parseInt(getInput('concurrency')) || 5,
      retry: parseInt(getInput('retry')) || 2,
      budget: parseFloat(getInput('budget')) || 1.00,
      
      // Behavior flags
      failOnErrors: getInput('fail-on-errors') === 'true',
      commentOnPr: getInput('comment-on-pr') === 'true',
      verbose: getInput('verbose') === 'true',
      
      // GitHub context
      token: getInput('token') || process.env.GITHUB_TOKEN,
      repository: getInput('repository') || context.repo.owner + '/' + context.repo.repo,
      prNumber: context.issue?.number || null,
      eventName: context.eventName
    };
  }

  /**
   * Initialize GitHub API client
   */
  async initializeGitHub() {
    if (!this.inputs.token) {
      warning('No GitHub token provided, PR comments will be skipped');
      return;
    }

    try {
      this.octokit = getOctokit(this.inputs.token);
      info('GitHub API client initialized');
    } catch (err) {
      warning(`Failed to initialize GitHub client: ${err.message}`);
    }
  }

  /**
   * Set up environment variables for API keys
   */
  setupEnvironment() {
    const envVars = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434'
    };

    // Log which API keys are available (without exposing values)
    Object.entries(envVars).forEach(([key, value]) => {
      if (value) {
        info(`✓ ${key} is configured`);
      } else {
        warning(`⚠ ${key} is not configured`);
      }
    });

    return envVars;
  }

  /**
   * Build CLI command with all parameters
   */
  buildCliCommand() {
    const args = [
      'glassbox',
      'test',
      '--test-dir', this.inputs.testDirectory,
      '--model', this.inputs.model,
      '--timeout', this.inputs.timeout.toString(),
      '--concurrency', this.inputs.concurrency.toString(),
      '--retry', this.inputs.retry.toString(),
      '--budget', this.inputs.budget.toString(),
      '--export', this.inputs.outputFormat,
      '--output', `test-results/results.${this.inputs.outputFormat}`,
      '--json'
    ];

    if (this.inputs.verbose) {
      args.push('--verbose');
    }

    return args.join(' ');
  }

  /**
   * Execute Glassbox CLI and capture results
   */
  async executeTests() {
    const command = this.buildCliCommand();
    info(`Executing: ${command}`);

    try {
      // Create results directory
      execSync('mkdir -p test-results', { stdio: 'inherit' });

      // Execute CLI command
      const output = execSync(command, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.setupEnvironment() }
      });

      // Save raw output
      writeFileSync('test-results/output.json', output);
      info('✓ Tests executed successfully');

      // Parse results
      this.results = JSON.parse(output);
      return true;

    } catch (err) {
      error(`❌ Test execution failed: ${err.message}`);
      
      // Try to capture partial output if available
      if (existsSync('test-results/output.json')) {
        try {
          const partialOutput = readFileSync('test-results/output.json', 'utf8');
          this.results = JSON.parse(partialOutput);
          warning('Using partial results from failed execution');
        } catch (parseErr) {
          error('Could not parse partial results');
        }
      }
      
      return false;
    }
  }

  /**
   * Extract key metrics from test results
   */
  parseResults() {
    if (!this.results) {
      return {
        total: 0,
        passed: 0,
        failed: 0,
        successRate: 0,
        totalCost: 0,
        totalDuration: 0,
        hasFailures: false
      };
    }

    const summary = this.results.aggregated?.summary || {};
    
    return {
      total: summary.total || 0,
      passed: summary.passed || 0,
      failed: summary.failed || 0,
      successRate: summary.successRate || 0,
      totalCost: summary.totalCost || 0,
      totalDuration: summary.totalDuration || 0,
      hasFailures: (summary.failed || 0) > 0
    };
  }

  /**
   * Generate markdown report for GitHub
   */
  generateReport(metrics) {
    const status = metrics.hasFailures ? '❌' : '✅';
    const resultText = metrics.hasFailures ? 'Some tests failed' : 'All tests passed!';
    
    return `# 🤖 Glassbox AI Test Results

## 📊 Summary
- **Total Tests**: ${metrics.total}
- **Passed**: ${metrics.passed}
- **Failed**: ${metrics.failed}
- **Success Rate**: ${metrics.successRate.toFixed(1)}%
- **Total Cost**: $${metrics.totalCost.toFixed(4)}
- **Total Duration**: ${metrics.totalDuration}ms

## ⚙️ Configuration
- **Model**: ${this.inputs.model}
- **Test Directory**: ${this.inputs.testDirectory}
- **Timeout**: ${this.inputs.timeout}ms
- **Concurrency**: ${this.inputs.concurrency}
- **Retries**: ${this.inputs.retry}
- **Budget**: $${this.inputs.budget}

## 📈 Results
${status} ${resultText}

## 📁 Artifacts
- [Test Results (${this.inputs.outputFormat})](test-results/results.${this.inputs.outputFormat})
- [Raw Output](test-results/output.json)

---
*Generated by Glassbox AI Test Runner*`;
  }

  /**
   * Post results as PR comment
   */
  async postPrComment(report) {
    if (!this.octokit || !this.inputs.prNumber || !this.inputs.commentOnPr) {
      info('Skipping PR comment (not a PR or comment disabled)');
      return;
    }

    try {
      // Find existing comment
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: this.inputs.prNumber
      });

      const existingComment = comments.find(comment => 
        comment.body.includes('🤖 Glassbox AI Test Results')
      );

      const commentBody = report + '\n\n---\n*This comment was automatically generated by the Glassbox AI Test Runner*';

      if (existingComment) {
        // Update existing comment
        await this.octokit.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: existingComment.id,
          body: commentBody
        });
        info('✓ Updated existing PR comment');
      } else {
        // Create new comment
        await this.octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: this.inputs.prNumber,
          body: commentBody
        });
        info('✓ Created new PR comment');
      }

    } catch (err) {
      warning(`Failed to post PR comment: ${err.message}`);
    }
  }

  /**
   * Set action outputs for other workflow steps
   */
  setOutputs(metrics) {
    setOutput('total', metrics.total);
    setOutput('passed', metrics.passed);
    setOutput('failed', metrics.failed);
    setOutput('success-rate', metrics.successRate);
    setOutput('total-cost', metrics.totalCost);
    setOutput('total-duration', metrics.totalDuration);
    setOutput('has-failures', metrics.hasFailures);
    setOutput('success', !metrics.hasFailures);
    
    info('✓ Action outputs set');
  }

  /**
   * Handle build failure based on results
   */
  handleBuildFailure(metrics) {
    if (this.inputs.failOnErrors && metrics.hasFailures) {
      setFailed(`Tests failed: ${metrics.failed}/${metrics.total} tests failed`);
      return true;
    }
    return false;
  }

  /**
   * Main execution flow
   */
  async run() {
    try {
      info('🚀 Starting Glassbox AI Test Runner');
      
      // Initialize GitHub client
      await this.initializeGitHub();
      
      // Execute tests
      const success = await this.executeTests();
      
      // Parse results
      const metrics = this.parseResults();
      
      // Generate report
      const report = this.generateReport(metrics);
      writeFileSync('test-results/report.md', report);
      
      // Set outputs
      this.setOutputs(metrics);
      
      // Post PR comment
      await this.postPrComment(report);
      
      // Handle build failure
      if (this.handleBuildFailure(metrics)) {
        process.exit(1);
      }
      
      info('✅ Glassbox action completed successfully');
      
    } catch (err) {
      error(`❌ Action failed: ${err.message}`);
      setFailed(err.message);
      process.exit(1);
    }
  }
}

// Execute the action
const action = new GlassboxAction();
action.run();
