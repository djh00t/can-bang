import assert from 'node:assert/strict'
import test from 'node:test'
import {
  navigateToTreeRelease,
  navigateToTreeTask,
  renderAgentPromptModal,
  renderPipelineCard,
  renderProjectTreeLabel,
  renderProjectSettingsPanel,
  shouldLoadPhaseBurndown,
  shouldReloadProjectMatrix,
} from '../src/workspace.js'

test('renders the onboarding modal with escaped prompt and agent link', () => {
  const html = renderAgentPromptModal(
    'https://example.test/d/project?key=secret',
    'Read <this-doc> and follow the briefing.',
    'Read /agents.md, then work the doc.',
  )

  assert.match(html, /Onboarding modal|One-line kickoff/)
  assert.match(html, /https:\/\/example\.test\/d\/project\?key=secret\.md/)
  assert.match(html, /id="agent-kickoff">Read \/agents\.md, then work the doc\./)
  assert.match(html, /id="agent-prompt">Read &lt;this-doc&gt;/)
  assert.match(html, /id="copy-agent-kickoff">Copy kickoff/)
  assert.match(html, /id="copy-agent-prompt">Copy briefing/)
  assert.doesNotMatch(html, /<this-doc>/)
})

test('renders the release badge on pipeline cards', () => {
  const html = renderPipelineCard(
    {
      id: 'task-1',
      title: 'Ship the demo',
      status: 'doing',
      assignee: null,
      feature: null,
      priority: null,
    },
    '0.3 demo',
  )

  assert.match(html, /class="chip release">🚀 0\.3 demo<\/span>/)
})

test('renders project names as expansion controls instead of navigation controls', () => {
  const html = renderProjectTreeLabel(
    { id: 'project-1', name: 'Project <One>', done: 2, total: 5 },
    false,
    false,
  )

  assert.match(html, /data-project-toggle="project-1"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /aria-controls="project-children-project-1"/)
  assert.match(html, /Project &lt;One&gt;/)
  assert.doesNotMatch(html, /data-project="project-1"/)
})

test('tree task navigation selects its owner and resets stale route state', () => {
  assert.deepEqual(
    navigateToTreeTask(
      {
        projectId: 'old-project',
        phaseId: null,
        view: 'matrix',
        detail: 'release',
        releaseId: 'old-release',
        taskId: null,
      },
      'new-project',
      'new-phase',
      'new-task',
    ),
    {
      projectId: 'new-project',
      phaseId: 'new-phase',
      view: 'pipeline',
      detail: 'project',
      releaseId: null,
      taskId: 'new-task',
    },
  )
})

test('cross-project release navigation reloads matrix data only when needed', () => {
  assert.equal(
    shouldReloadProjectMatrix({ projectId: 'old-project', view: 'matrix' }, 'new-project'),
    true,
  )
  assert.equal(
    shouldReloadProjectMatrix({ projectId: 'same-project', view: 'matrix' }, 'same-project'),
    false,
  )
  assert.equal(
    shouldReloadProjectMatrix({ projectId: 'old-project', view: 'pipeline' }, 'new-project'),
    false,
  )
})

test('cross-project phase navigation loads an uncached burndown', () => {
  assert.equal(shouldLoadPhaseBurndown('new-phase', new Map()), true)
  assert.equal(shouldLoadPhaseBurndown('cached-phase', new Map([['cached-phase', {}]])), false)
  assert.equal(shouldLoadPhaseBurndown(null, new Map()), false)
})

test('tree release navigation clears stale task state and uses the release phase', () => {
  const state = {
    projectId: 'old-project',
    phaseId: 'old-phase',
    view: 'pipeline' as const,
    detail: 'project' as const,
    releaseId: null,
    taskId: 'old-task',
  }

  assert.deepEqual(navigateToTreeRelease(state, 'new-project', 'new-phase', 'new-release'), {
    projectId: 'new-project',
    phaseId: 'new-phase',
    view: 'pipeline',
    detail: 'release',
    releaseId: 'new-release',
    taskId: null,
  })
  assert.deepEqual(navigateToTreeRelease(state, 'new-project', 'new-phase', null), {
    projectId: 'new-project',
    phaseId: 'new-phase',
    view: 'pipeline',
    detail: 'project',
    releaseId: null,
    taskId: null,
  })
})

test('renders escaped project settings with GitHub and one-time key controls', () => {
  const html = renderProjectSettingsPanel({
    id: 'project-1',
    name: '<Project>',
    description: 'A useful project',
    docId: 'doc/1',
    docTitle: 'HQ',
    github: { enabled: false, repo: null, syncEnabled: false },
  })

  assert.match(html, /Project settings/)
  assert.match(html, /value="&lt;Project&gt;"/)
  assert.match(html, /A useful project/)
  assert.match(html, /href="\/d\/doc%2F1"/)
  assert.match(html, /GitHub Issues sync/)
  assert.match(html, /id="enable-github"/)
  assert.match(html, /id="mint-project-key"/)
  assert.match(html, /secret is shown once/)
  assert.doesNotMatch(html, /<Project>/)
})
