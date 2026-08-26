import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSignalModel,
  escapeXml,
  renderSignalSvg,
  run,
  summarizeDays,
} from "./generate-contribution-signal.mjs";

function fixturePayload() {
  return {
    data: {
      user: {
        contributionsCollection: {
          contributionCalendar: {
            totalContributions: 12,
            weeks: [{
              contributionDays: [
                { contributionCount: 0, date: "2026-08-23", weekday: 0 },
                { contributionCount: 2, date: "2026-08-24", weekday: 1 },
                { contributionCount: 4, date: "2026-08-25", weekday: 2 },
                { contributionCount: 6, date: "2026-08-26", weekday: 3 },
              ],
            }],
          },
          commitContributionsByRepository: [
            { repository: { nameWithOwner: "harshitthek/resilient", isPrivate: false, url: "https://github.com/harshitthek/resilient" }, contributions: { totalCount: 7 } },
            { repository: { nameWithOwner: "harshitthek/private-lab", isPrivate: true, url: "https://github.com/harshitthek/private-lab" }, contributions: { totalCount: 99 } },
            { repository: { nameWithOwner: "harshitthek/harshitthek", isPrivate: false, url: "https://github.com/harshitthek/harshitthek" }, contributions: { totalCount: 2 } },
          ],
          pullRequestContributionsByRepository: [
            { repository: { nameWithOwner: "MakazhanAlpamys/Soup", isPrivate: false, url: "https://github.com/MakazhanAlpamys/Soup" }, contributions: { totalCount: 3 } },
          ],
        },
      },
    },
  };
}

test("escapeXml protects generated SVG text", () => {
  assert.equal(escapeXml(`<repo name="x"> & 'y'`), "&lt;repo name=&quot;x&quot;&gt; &amp; &apos;y&apos;");
});

test("summarizeDays computes active, current, and longest streaks", () => {
  const days = [
    { date: "2026-08-23", contributionCount: 0 },
    { date: "2026-08-24", contributionCount: 1 },
    { date: "2026-08-25", contributionCount: 2 },
    { date: "2026-08-26", contributionCount: 1 },
  ];
  assert.deepEqual(summarizeDays(days, new Date("2026-08-26T12:00:00Z")), {
    activeDays: 3,
    currentStreak: 3,
    longestStreak: 3,
  });
});

test("model excludes private repositories and the profile repository", () => {
  const model = buildSignalModel(fixturePayload(), 8, {
    username: "harshitthek",
    today: new Date("2026-08-26T12:00:00Z"),
  });
  assert.deepEqual(model.topRepositories.map((repo) => repo.nameWithOwner), [
    "harshitthek/resilient",
    "MakazhanAlpamys/Soup",
  ]);
  assert.equal(JSON.stringify(model).includes("private-lab"), false);
  assert.equal(model.externalMergedPullRequests, 8);
});

test("rendering is deterministic and valid-looking for sparse data", () => {
  const model = buildSignalModel(fixturePayload(), 8, {
    username: "harshitthek",
    today: new Date("2026-08-26T12:00:00Z"),
  });
  const first = renderSignalSvg(model);
  const second = renderSignalSvg(model);
  assert.equal(first, second);
  assert.match(first, /^<svg/);
  assert.match(first, /OPEN SOURCE SIGNAL MAP/);
  assert.match(first, /prefers-reduced-motion/);
  assert.doesNotMatch(first, /private-lab/);
  assert.doesNotMatch(first, /[ \t]+$/m);
});

test("empty contribution data renders a stable zero-state", () => {
  const payload = fixturePayload();
  payload.data.user.contributionsCollection.contributionCalendar.totalContributions = 0;
  payload.data.user.contributionsCollection.contributionCalendar.weeks = [];
  payload.data.user.contributionsCollection.commitContributionsByRepository = [];
  payload.data.user.contributionsCollection.pullRequestContributionsByRepository = [];
  const svg = renderSignalSvg(buildSignalModel(payload, 0, { username: "harshitthek" }));
  assert.match(svg, />0<\/text><text x="650"/);
  assert.match(svg, /PUBLIC REPOSITORY ACTIVITY IS INDEXING/);
});

test("a failed API request leaves the last good SVG untouched", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "profile-signal-"));
  const outputPath = path.join(directory, "signal.svg");
  await writeFile(outputPath, "<svg>last-good</svg>", "utf8");

  await assert.rejects(
    run({
      token: "test-token",
      username: "harshitthek",
      outputPath,
      fetchImpl: async () => { throw new Error("network down"); },
    }),
    /network down/,
  );
  assert.equal(await readFile(outputPath, "utf8"), "<svg>last-good</svg>");
});
