const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');
const reportPlan = require('../report-plan.js');

const fixture = path.join(__dirname, 'fixtures', 'plan.txt');
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tofu-'));
fs.writeFileSync(
  path.join(fakeBin, 'tofu'),
  '#!/bin/sh\n[ "$FAKE_TOFU_FAIL" = "true" ] && { echo "Error: broken plan" >&2; exit 1; }\ncat "$FAKE_TOFU_OUTPUT"\n',
  { mode: 0o755 },
);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;

function fakeCore() {
  const core = { summaries: [], warnings: [] };
  core.warning = (message) => core.warnings.push(message);
  core.summary = {
    addRaw: (text) => {
      core.summaries.push(text);
      return core.summary;
    },
    write: async () => core.summary,
  };
  return core;
}

function fakeGitHub(comments = []) {
  const calls = [];
  const github = {
    calls,
    comments,
    paginate: async (method, params) => method(params),
    rest: {
      issues: {
        listComments: async ({ issue_number }) => {
          calls.push(['list', issue_number]);
          return comments;
        },
        createComment: async ({ issue_number, body }) => {
          calls.push(['create', issue_number]);
          comments.push({ id: comments.length + 1, body });
        },
        updateComment: async ({ comment_id, body }) => {
          calls.push(['update', comment_id]);
          comments.find((comment) => comment.id === comment_id).body = body;
        },
      },
    },
  };
  return github;
}

function pullRequestContext() {
  return {
    serverUrl: 'https://github.com',
    repo: { owner: 'gi-org-pl', repo: 'example' },
    runId: 123,
    sha: 'ffffffffffffffff',
    payload: { pull_request: { number: 42, head: { sha: '466d1f5abcdef' } } },
  };
}

function pushContext() {
  return { ...pullRequestContext(), payload: {} };
}

let workspace;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-'));
  fs.mkdirSync(path.join(workspace, 'infra'));
  fs.writeFileSync(path.join(workspace, 'infra', 'tfplan'), 'binary plan');
  process.chdir(workspace);
  process.env.WORKING_DIRECTORY = 'infra';
  process.env.PLAN_FILE = 'tfplan';
  process.env.COMMENT = 'true';
  process.env.FAKE_TOFU_OUTPUT = fixture;
  process.env.FAKE_TOFU_FAIL = 'false';
});

describe('report-plan', () => {
  it('comments the plan on a pull request and writes it to the job summary', async () => {
    const github = fakeGitHub();
    const core = fakeCore();

    await reportPlan({ github, context: pullRequestContext(), core });

    assert.deepEqual(github.calls, [
      ['list', 42],
      ['create', 42],
    ]);
    const body = github.comments[0].body;
    assert.match(
      body,
      /^<!-- report-tofu-plan-action:infra -->\n## OpenTofu plan for `infra`\n/,
    );
    assert.match(
      body,
      /Commit `466d1f5` · Plan: 2 to add, 1 to change, 2 to destroy\./,
    );
    assert.match(body, /^\+  \+ resource "terraform_data" "queue"/m);
    assert.match(body, /^-  - resource "terraform_data" "instance"/m);
    assert.match(body, /^!  ~ resource "terraform_data" "task"/m);
    assert.match(body, /^!-\/\+ resource "terraform_data" "tunnel"/m);
    assert.match(body, /^\+          \+ "4\.1\.2",/m);
    assert.match(body, /^         id     = /m);
    assert.match(
      body,
      /\[Workflow run\]\(https:\/\/github\.com\/gi-org-pl\/example\/actions\/runs\/123\)$/,
    );

    assert.equal(core.summaries.length, 1);
    assert.ok(body.includes(core.summaries[0]));
    assert.doesNotMatch(core.summaries[0], /<!--|Workflow run/);
  });

  it('updates its own comment and leaves other comments alone', async () => {
    const github = fakeGitHub([
      { id: 1, body: '<!-- performance-results -->\nperf' },
      { id: 2, body: '<!-- report-tofu-plan-action:infra -->\nold plan' },
    ]);

    await reportPlan({
      github,
      context: pullRequestContext(),
      core: fakeCore(),
    });

    assert.deepEqual(github.calls.at(-1), ['update', 2]);
    assert.equal(github.comments.length, 2);
    assert.equal(github.comments[0].body, '<!-- performance-results -->\nperf');
    assert.match(github.comments[1].body, /Plan: 2 to add/);
  });

  it('keeps a separate comment for each working directory', async () => {
    const github = fakeGitHub([
      { id: 1, body: '<!-- report-tofu-plan-action:infra -->\ninfra plan' },
    ]);
    fs.writeFileSync(path.join(workspace, 'tfplan'), 'binary plan');
    process.env.WORKING_DIRECTORY = '.';

    await reportPlan({
      github,
      context: pullRequestContext(),
      core: fakeCore(),
    });

    assert.deepEqual(github.calls.at(-1), ['create', 42]);
    assert.match(
      github.comments[1].body,
      /^<!-- report-tofu-plan-action:\. -->\n## OpenTofu plan\n/,
    );
  });

  it('writes only the job summary outside pull requests', async () => {
    const github = fakeGitHub();
    const core = fakeCore();

    await reportPlan({ github, context: pushContext(), core });

    assert.deepEqual(github.calls, []);
    assert.match(core.summaries[0], /Commit `fffffff` · Plan: 2 to add/);
  });

  it('does not comment when commenting is turned off', async () => {
    const github = fakeGitHub();
    const core = fakeCore();
    process.env.COMMENT = 'false';

    await reportPlan({ github, context: pullRequestContext(), core });

    assert.deepEqual(github.calls, []);
    assert.equal(core.summaries.length, 1);
  });

  it('reports a failed plan when the plan file is missing', async () => {
    const github = fakeGitHub();
    const core = fakeCore();
    fs.rmSync(path.join(workspace, 'infra', 'tfplan'));

    await reportPlan({ github, context: pullRequestContext(), core });

    assert.match(
      github.comments[0].body,
      /Commit `466d1f5` · \*\*The plan failed\.\*\*/,
    );
    assert.doesNotMatch(github.comments[0].body, /<details>/);
    assert.match(core.warnings[0], /Plan file tfplan not found in infra/);
  });

  it('reports a failed plan when tofu cannot read the plan', async () => {
    const core = fakeCore();
    process.env.FAKE_TOFU_FAIL = 'true';

    await reportPlan({
      github: fakeGitHub(),
      context: pullRequestContext(),
      core,
    });

    assert.match(core.summaries[0], /\*\*The plan failed\.\*\*/);
    assert.match(core.warnings[0], /Could not read the plan/);
  });

  it('summarizes plans without resource changes', async () => {
    const output = path.join(workspace, 'plan.txt');
    process.env.FAKE_TOFU_OUTPUT = output;

    fs.writeFileSync(
      output,
      '\nNo changes. Your infrastructure matches the configuration.\n',
    );
    const unchanged = fakeCore();
    await reportPlan({
      github: fakeGitHub(),
      context: pushContext(),
      core: unchanged,
    });
    assert.match(
      unchanged.summaries[0],
      /· No changes\. Your infrastructure matches/,
    );

    fs.writeFileSync(
      output,
      'Changes to Outputs:\n  ~ image_tag = "4.1.0" -> "4.1.2"\n',
    );
    const outputsOnly = fakeCore();
    await reportPlan({
      github: fakeGitHub(),
      context: pushContext(),
      core: outputsOnly,
    });
    assert.match(outputsOnly.summaries[0], /· Only outputs change\./);
  });

  it('truncates plans that do not fit in a comment', async () => {
    const output = path.join(workspace, 'plan.txt');
    process.env.FAKE_TOFU_OUTPUT = output;
    fs.writeFileSync(
      output,
      `  + resource "x" "y" {\n${'      + a = "b"\n'.repeat(20)}`.repeat(400),
    );
    const github = fakeGitHub();

    await reportPlan({
      github,
      context: pullRequestContext(),
      core: fakeCore(),
    });

    const body = github.comments[0].body;
    assert.ok(body.length < 65536, `comment has ${body.length} characters`);
    assert.match(body, /… truncated, see the job logs\n```\n\n<\/details>/);
  });
});
