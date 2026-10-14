const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const planLimit = 60000;

function readPlan(workingDirectory, planFile, core) {
  if (!fs.existsSync(path.resolve(workingDirectory, planFile))) {
    core.warning(`Plan file ${planFile} not found in ${workingDirectory}`);
    return '';
  }

  try {
    return execFileSync('tofu', ['show', '-no-color', planFile], {
      cwd: workingDirectory,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    core.warning(`Could not read the plan: ${error.message}`);
    return '';
  }
}

function diffMarker(line) {
  const sign = line.match(/^ *(-\/\+|\+\/-|[-+~]) /)?.[1];
  if (!sign) return ' ';
  return sign === '+' || sign === '-' ? sign : '!';
}

function asDiff(plan) {
  return plan
    .split('\n')
    .map((line) => `${diffMarker(line)}${line}`)
    .join('\n');
}

function summaryOf(plan) {
  return (
    plan.split('\n').find((line) => /^(Plan:|No changes\.)/.test(line)) ??
    'Only outputs change.'
  );
}

function reportMarkdown({ plan, title, commit }) {
  const header = `## ${title}\n\nCommit \`${commit}\``;

  if (!plan) {
    return `${header} · **The plan failed.** See the job logs for the error.`;
  }

  const diff = asDiff(plan);
  const shown =
    diff.length > planLimit
      ? `${diff.slice(0, planLimit)}\n… truncated, see the job logs`
      : diff;

  return `${header} · ${summaryOf(plan)}\n\n<details><summary>Show plan</summary>\n\n\`\`\`diff\n${shown}\n\`\`\`\n\n</details>`;
}

async function upsertComment({ github, context, issueNumber, marker, body }) {
  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
  });
  const previous = comments.find((comment) => comment.body?.startsWith(marker));

  if (previous) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: previous.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }
}

module.exports = async ({ github, context, core }) => {
  const workingDirectory = process.env.WORKING_DIRECTORY || '.';
  const planFile = process.env.PLAN_FILE || 'tfplan';
  const directory = path.relative('.', workingDirectory) || '.';
  const pullRequest = context.payload.pull_request;

  const report = reportMarkdown({
    plan: readPlan(workingDirectory, planFile, core),
    title:
      directory === '.'
        ? 'OpenTofu plan'
        : `OpenTofu plan for \`${directory}\``,
    commit: (pullRequest?.head.sha ?? context.sha).slice(0, 7),
  });

  await core.summary.addRaw(report).write();

  if (!pullRequest || process.env.COMMENT !== 'true') return;

  const { owner, repo } = context.repo;
  const marker = `<!-- report-tofu-plan-action:${directory} -->`;
  const run = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  await upsertComment({
    github,
    context,
    issueNumber: pullRequest.number,
    marker,
    body: `${marker}\n${report}\n\n[Workflow run](${run})`,
  });
};
