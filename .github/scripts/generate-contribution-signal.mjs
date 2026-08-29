import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const GRAPHQL_URL = "https://api.github.com/graphql";
const SEARCH_URL = "https://api.github.com/search/issues";

const CONTRIBUTION_QUERY = `
  query ProfileSignal($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              date
              weekday
            }
          }
        }
        commitContributionsByRepository(maxRepositories: 20) {
          repository { nameWithOwner isPrivate url }
          contributions(first: 1) { totalCount }
        }
        pullRequestContributionsByRepository(maxRepositories: 20) {
          repository { nameWithOwner isPrivate url }
          contributions(first: 1) { totalCount }
        }
      }
    }
  }
`;

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function utcDayNumber(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Math.floor(date.getTime() / 86_400_000);
}

export function summarizeDays(days, today = new Date()) {
  const ordered = [...days]
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date))
    .sort((left, right) => left.date.localeCompare(right.date));

  const activeDays = ordered.filter((day) => day.contributionCount > 0).length;
  let longestStreak = 0;
  let runningStreak = 0;
  let previousActiveDay = null;

  for (const day of ordered) {
    if (day.contributionCount <= 0) {
      runningStreak = 0;
      previousActiveDay = null;
      continue;
    }

    const dayNumber = utcDayNumber(day.date);
    runningStreak = previousActiveDay === dayNumber - 1 ? runningStreak + 1 : 1;
    previousActiveDay = dayNumber;
    longestStreak = Math.max(longestStreak, runningStreak);
  }

  const todayNumber = Math.floor(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  ) / 86_400_000);
  const active = ordered.filter((day) => day.contributionCount > 0);
  const latest = active.at(-1);
  let currentStreak = 0;

  if (latest && todayNumber - utcDayNumber(latest.date) <= 1) {
    let expected = utcDayNumber(latest.date);
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const dayNumber = utcDayNumber(active[index].date);
      if (dayNumber !== expected) break;
      currentStreak += 1;
      expected -= 1;
    }
  }

  return { activeDays, currentStreak, longestStreak };
}

function repositoryContributionCount(row) {
  return Number(row?.contributions?.totalCount ?? 0);
}

export function buildSignalModel(payload, externalMergedPullRequests = 0, options = {}) {
  const username = options.username ?? "harshitthek";
  const today = options.today ?? new Date();
  const collection = payload?.data?.user?.contributionsCollection;
  const calendar = collection?.contributionCalendar;

  if (!calendar || !Array.isArray(calendar.weeks)) {
    throw new Error("GitHub returned no contribution calendar");
  }

  const sourceWeeks = calendar.weeks.slice(-52);
  const weeks = sourceWeeks.map((week) => {
    const days = Array.isArray(week.contributionDays) ? week.contributionDays : [];
    const byWeekday = new Map(days.map((day) => [Number(day.weekday), day]));
    return Array.from({ length: 7 }, (_, weekday) => {
      const day = byWeekday.get(weekday);
      return {
        contributionCount: Math.max(0, Number(day?.contributionCount ?? 0)),
        date: day?.date ?? "",
        weekday,
      };
    });
  });

  while (weeks.length < 52) {
    weeks.unshift(Array.from({ length: 7 }, (_, weekday) => ({
      contributionCount: 0,
      date: "",
      weekday,
    })));
  }

  const days = weeks.flat().filter((day) => day.date);
  const stats = summarizeDays(days, today);
  const repoCounts = new Map();
  const contributionRows = [
    ...(collection.commitContributionsByRepository ?? []),
    ...(collection.pullRequestContributionsByRepository ?? []),
  ];

  for (const row of contributionRows) {
    const repository = row?.repository;
    if (!repository || repository.isPrivate || !repository.nameWithOwner) continue;
    if (repository.nameWithOwner.toLowerCase() === `${username}/${username}`.toLowerCase()) continue;
    const current = repoCounts.get(repository.nameWithOwner) ?? { count: 0, url: repository.url };
    current.count += repositoryContributionCount(row);
    repoCounts.set(repository.nameWithOwner, current);
  }

  const topRepositories = [...repoCounts.entries()]
    .map(([nameWithOwner, value]) => ({ nameWithOwner, ...value }))
    .sort((left, right) => right.count - left.count || left.nameWithOwner.localeCompare(right.nameWithOwner))
    .slice(0, 4);

  return {
    username,
    totalContributions: days.reduce((sum, day) => sum + day.contributionCount, 0),
    externalMergedPullRequests: Math.max(0, Number(externalMergedPullRequests ?? 0)),
    weeks,
    topRepositories,
    ...stats,
  };
}

function compactRepositoryName(nameWithOwner) {
  const name = nameWithOwner.split("/").at(-1) ?? nameWithOwner;
  return name.length > 19 ? `${name.slice(0, 17)}..` : name;
}

function contributionColor(count, maxCount) {
  if (count <= 0) return "#202A30";
  const ratio = maxCount > 0 ? count / maxCount : 0;
  if (ratio < 0.25) return "#28504A";
  if (ratio < 0.5) return "#2F8076";
  if (ratio < 0.75) return "#45B8A8";
  return "#5EEAD4";
}

export function renderSignalSvg(model) {
  const width = 1200;
  const height = 390;
  const graphLeft = 70;
  const graphWidth = 1060;
  const weekStep = graphWidth / 51;
  const weekTotals = model.weeks.map((week) => week.reduce((sum, day) => sum + day.contributionCount, 0));
  const maxWeek = Math.max(1, ...weekTotals);
  const allCounts = model.weeks.flat().map((day) => day.contributionCount);
  const maxDay = Math.max(1, ...allCounts);
  const signalPoints = weekTotals.map((total, index) => {
    const x = graphLeft + index * weekStep;
    const y = 230 - (total / maxWeek) * 72;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const calendarCells = model.weeks.flatMap((week, weekIndex) => week.map((day) => {
    const x = graphLeft + weekIndex * weekStep - 4;
    const y = 268 + day.weekday * 10;
    return `<rect x="${x.toFixed(1)}" y="${y}" width="8" height="8" rx="2" fill="${contributionColor(day.contributionCount, maxDay)}"/>`;
  })).join("");

  const nodePositions = [170, 445, 720, 995];
  const repositoryNodes = model.topRepositories.map((repository, index) => {
    const x = nodePositions[index];
    const label = escapeXml(compactRepositoryName(repository.nameWithOwner));
    return `
      <g>
        <path d="M${x} 142V176" stroke="#3D4B54" stroke-dasharray="4 5"/>
        <circle cx="${x}" cy="132" r="17" fill="#10171C" stroke="#5EEAD4"/>
        <circle cx="${x}" cy="132" r="7" fill="#5EEAD4" class="node node-${index}"/>
        <text x="${x}" y="103" text-anchor="middle" class="mono repo">${label}</text>
        <text x="${x}" y="137" text-anchor="middle" class="mono count">${repository.count}</text>
      </g>`;
  }).join("");

  const description = escapeXml(
    `${model.totalContributions} public contributions across ${model.activeDays} active days, ` +
    `${model.currentStreak} day current streak, ${model.externalMergedPullRequests} merged upstream pull requests.`,
  );

  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Open Source Signal Map for ${escapeXml(model.username)}</title>
  <desc id="desc">${description}</desc>
  <defs>
    <linearGradient id="bg" x1="20" y1="20" x2="1180" y2="370" gradientUnits="userSpaceOnUse"><stop stop-color="#090D10"/><stop offset=".55" stop-color="#10171C"/><stop offset="1" stop-color="#17120E"/></linearGradient>
    <linearGradient id="signal" x1="70" y1="230" x2="1130" y2="158" gradientUnits="userSpaceOnUse"><stop stop-color="#5EEAD4"/><stop offset=".45" stop-color="#60A5FA"/><stop offset=".75" stop-color="#FBBF24"/><stop offset="1" stop-color="#FB7185"/></linearGradient>
    <pattern id="grid" width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" stroke="#263139" opacity=".36"/></pattern>
    <filter id="glow" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <style>
      .mono{font-family:"Fira Code",Consolas,"Liberation Mono",monospace}.sans{font-family:Inter,ui-sans-serif,system-ui,sans-serif}.label{fill:#73808A;font-size:11px}.metric{fill:#F8FAFC;font-size:24px;font-weight:800}.repo{fill:#C8D2DA;font-size:11px}.count{fill:#07100E;font-size:9px;font-weight:800}.signal{stroke-dasharray:10 12;animation:flow 6s linear infinite}.scanner{animation:scan 6.5s ease-in-out infinite}.node{animation:pulse 3.1s ease-in-out infinite;transform-box:fill-box;transform-origin:center}.node-1{animation-delay:.65s}.node-2{animation-delay:1.3s}.node-3{animation-delay:1.95s}@keyframes flow{to{stroke-dashoffset:-44}}@keyframes scan{0%,10%{transform:translateX(-80px);opacity:0}28%,72%{opacity:.7}90%,100%{transform:translateX(1110px);opacity:0}}@keyframes pulse{0%,100%{opacity:.42;transform:scale(.7)}50%{opacity:1;transform:scale(1.25)}}@media(prefers-reduced-motion:reduce){.signal,.scanner,.node{animation:none}}
    </style>
  </defs>
  <rect x="1" y="1" width="1198" height="388" rx="12" fill="url(#bg)" stroke="#2C3740" stroke-width="2"/>
  <rect x="1" y="1" width="1198" height="388" rx="12" fill="url(#grid)"/>
  <text x="42" y="42" class="mono label">LIVE / PUBLIC GITHUB TELEMETRY</text>
  <text x="42" y="77" class="sans" fill="#F8FAFC" font-size="26" font-weight="800">OPEN SOURCE SIGNAL MAP</text>
  <text x="1146" y="42" text-anchor="end" class="mono label">52 WEEK WINDOW</text>

  <g>
    <text x="650" y="76" class="mono metric">${model.totalContributions}</text><text x="650" y="96" class="mono label">CONTRIBUTIONS</text>
    <text x="790" y="76" class="mono metric">${model.activeDays}</text><text x="790" y="96" class="mono label">ACTIVE DAYS</text>
    <text x="913" y="76" class="mono metric">${model.currentStreak}</text><text x="913" y="96" class="mono label">CURRENT STREAK</text>
    <text x="1056" y="76" class="mono metric">${model.externalMergedPullRequests}</text><text x="1056" y="96" class="mono label">UPSTREAM MERGES</text>
  </g>

  ${repositoryNodes || `<text x="600" y="132" text-anchor="middle" class="mono repo">PUBLIC REPOSITORY ACTIVITY IS INDEXING</text>`}
  <polyline points="${signalPoints}" stroke="#33424B" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="${signalPoints}" stroke="url(#signal)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="signal" filter="url(#glow)"/>
  <rect x="30" y="149" width="28" height="112" fill="#5EEAD4" opacity=".05" class="scanner"/>
  <text x="42" y="254" class="mono label">DAILY CONTRIBUTION CIRCUIT</text>
  <g>${calendarCells}</g>
  <path d="M42 352H1158" stroke="#303B43"/>
  <text x="42" y="374" class="mono label">ACTIVE NOW: ${escapeXml(model.topRepositories.map((repo) => compactRepositoryName(repo.nameWithOwner)).join(" / ") || "PUBLIC BUILDS")}</text>
  <text x="1158" y="374" text-anchor="end" class="mono label">LONGEST STREAK: ${model.longestStreak} DAYS</text>
</svg>
`;
  return svg.split("\n").map((line) => line.trimEnd()).join("\n");
}

async function requestJson(url, init, fetchImpl) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}): ${body.slice(0, 240)}`);
  }
  return response.json();
}

export async function fetchSignalPayload({ token, username, fetchImpl = fetch, now = new Date() }) {
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const to = new Date(now);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 364);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "harshitthek-profile-signal",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const contributionPayload = await requestJson(GRAPHQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: CONTRIBUTION_QUERY,
      variables: { login: username, from: from.toISOString(), to: to.toISOString() },
    }),
  }, fetchImpl);

  if (contributionPayload.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${contributionPayload.errors[0].message}`);
  }

  const query = encodeURIComponent(`author:${username} is:pr is:merged -user:${username}`);
  const pullRequestPayload = await requestJson(`${SEARCH_URL}?q=${query}&per_page=1`, {
    method: "GET",
    headers,
  }, fetchImpl);

  return {
    contributionPayload,
    externalMergedPullRequests: Number(pullRequestPayload.total_count ?? 0),
  };
}

export async function run(options = {}) {
  const username = options.username ?? process.env.PROFILE_USERNAME ?? "harshitthek";
  const outputPath = options.outputPath ?? process.env.OUTPUT_PATH ?? "assets/activity/contribution-signal.svg";
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const { contributionPayload, externalMergedPullRequests } = await fetchSignalPayload({
    token,
    username,
    fetchImpl,
    now,
  });
  const model = buildSignalModel(contributionPayload, externalMergedPullRequests, { username, today: now });
  const svg = renderSignalSvg(model);

  await mkdir(path.dirname(outputPath), { recursive: true });
  let previous = null;
  try {
    previous = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (previous === svg) return { changed: false, model };
  await writeFile(outputPath, svg, "utf8");
  return { changed: true, model };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run()
    .then(({ changed, model }) => {
      console.log(
        `${changed ? "Updated" : "Unchanged"} contribution signal: ` +
        `${model.totalContributions} contributions, ${model.externalMergedPullRequests} upstream merges`,
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
