import { execFileSync } from 'node:child_process';

// These are the production targets, not whichever project a CLI last selected.
const repo = 'Arindam200/docxy';
const railwayProject = '5c333e8f-d5fc-4440-82e8-427386ec0350';
const railwayEnvironment = '07200c23-c711-4fb6-a65e-09cbd4c22ea6';
const railwayService = 'af62c917-dffd-48f3-9b69-87f42b1f7a91';
const vercelProject = 'prj_3RMsBtkY6Xhe6XnODSW1M8q1DdyJ';
const vercelTeam = 'team_cdvXdtZcRcvBbmuVjmM6EVsG';
const backendUrl = 'https://docxy-production.up.railway.app';

function json(command, args) {
  try {
    return JSON.parse(execFileSync(command, args, {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    throw new Error(`${command} could not read deployment settings. Check CLI login and network access.`);
  }
}

function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
  if (!condition) process.exitCode = 1;
}

try {
  const vercel = json('vercel', ['api', `/v9/projects/${vercelProject}?teamId=${vercelTeam}`, '--raw']);
  check('Vercel deploys Docxy main from web/',
    vercel.link?.org + '/' + vercel.link?.repo === repo &&
    vercel.link?.productionBranch === 'main' && vercel.rootDirectory === 'web' &&
    vercel.gitProviderOptions?.createDeployments !== 'disabled');
  const env = vercel.env ?? [];
  check('Composio key is configured for Vercel production',
    env.some(item => item.key === 'COMPOSIO_API_KEY' && item.target?.includes('production')));
  const apiUrl = env.find(item => item.key === 'DOCXY_API_URL' && item.target?.includes('production'));
  // Project metadata can contain an encrypted value even for readable config.
  const resolvedApiUrl = apiUrl ? json('vercel', ['api', `/v1/projects/${vercelProject}/env/${apiUrl.id}?teamId=${vercelTeam}`, '--raw']) : null;
  check('Vercel points at the production backend', resolvedApiUrl?.value === backendUrl);

  const railway = json('railway', ['status', '--project', railwayProject, '--environment', 'production', '--json']);
  const environment = railway.environments.edges.find(item => item.node.id === railwayEnvironment)?.node;
  const service = environment?.serviceInstances.edges.find(item => item.node.serviceId === railwayService)?.node;
  check('Railway production service is connected to the Docxy repository', service?.source?.repo === repo);
  const automatic = json('railway', ['api', `query {
    serviceInstanceAutoDeployStatus(projectId: "${railwayProject}", environmentId: "${railwayEnvironment}", serviceId: "${railwayService}") {
      enabled
    }
  }`, '--compact']);
  check('Railway auto-deploy is enabled', automatic.data?.serviceInstanceAutoDeployStatus?.enabled === true);
  check('Latest Railway deployment succeeded', service?.latestDeployment?.status === 'SUCCESS');
  check('Latest Vercel production deployment is ready', vercel.targets?.production?.readyState === 'READY');
  const backendCommit = service?.latestDeployment?.meta?.commitHash;
  check('Latest Railway deployment came from main', service?.latestDeployment?.meta?.branch === 'main');
  const frontendCommit = vercel.targets?.production?.meta?.githubCommitSha;
  check('Frontend and backend run the same GitHub revision', Boolean(backendCommit && backendCommit === frontendCommit));
  if (backendCommit) console.log(`Backend revision: ${backendCommit.slice(0, 12)}`);
  if (frontendCommit) console.log(`Frontend revision: ${frontendCommit.slice(0, 12)}`);

  for (const url of ['https://docxy.app', `${backendUrl}/health`]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    check(`${url} responds successfully`, response.ok);
    if (url.endsWith('/health') && response.ok) {
      const health = await response.json();
      check('Backend model and sandbox are configured', health.ok === true && health.model === 'configured' && health.sandbox === 'configured');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deployment checks failed');
  process.exitCode = 1;
}
