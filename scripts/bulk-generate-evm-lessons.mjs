#!/usr/bin/env node
/// Bulk-author EVM-harness exercises for `mastering-ethereum` (and
/// any other course where `harness: "evm"` makes sense). Calls
/// Anthropic directly using a system prompt that documents the
/// `chain.*` API the in-process @ethereumjs/vm runner exposes
/// (see src/runtimes/evm.ts).
///
/// Different shape from `bulk-generate-challenges.mjs`:
///   - We target a SPECIFIC course (mastering-ethereum), not a
///     fresh language pack — exercises get appended to existing
///     chapters.
///   - Each lesson is `kind: "exercise"`, `language: "solidity"`,
///     `harness: "evm"`. The starter is real Solidity; the tests
///     are JavaScript driving `chain.deploy(...)` etc.
///   - Topics are EVM-flavoured (storage, modifiers, events,
///     reverts, payable, time, multi-actor).
///
/// Usage:
///   node scripts/bulk-generate-evm-lessons.mjs                 # 20 new
///   COUNT=10 node scripts/bulk-generate-evm-lessons.mjs        # 10 new
///   COURSE_ID=mastering-ethereum node scripts/...              # other course
///   DRY_RUN=1 node scripts/...                                 # plan only
///   CONCURRENCY=4 node scripts/...                             # default 4

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_SUPPORT = join(
  homedir(),
  "Library/Application Support/com.mattssoftware.libre",
);
const SETTINGS_PATH = join(APP_SUPPORT, "settings.json");
const COURSES_DIR = join(APP_SUPPORT, "courses");

const COURSE_ID = process.env.COURSE_ID ?? "mastering-ethereum";
const COUNT = Number(process.env.COUNT ?? 20);
const START = Number(process.env.START ?? 0);
const DRY_RUN = !!process.env.DRY_RUN;
const MODEL = process.env.MODEL ?? "claude-sonnet-4-8";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 4));

/// Topic + difficulty buckets the LLM rotates through. Each entry is
/// (chapter id, topic, difficulty). All EVM-harness lessons land in
/// the existing ch04-smart-contracts-evm chapter (the runtime + the
/// linear flow keep both sides happy — chapter 4 IS smart contracts +
/// EVM in the book, so an extra ~120 exercises there fits the
/// curriculum). We bias toward MEDIUM/HARD since the easy slots only
/// cover ~25 distinct beginner concepts; the depth of the pack lives
/// in medium and hard.
const PLAN = [
  // ── Easy (25): single contract, one or two pieces of state ──
  ["ch04-smart-contracts-evm", "storage uint256 read+write", "easy"],
  ["ch04-smart-contracts-evm", "storage address with setter", "easy"],
  ["ch04-smart-contracts-evm", "storage bool flag with toggle", "easy"],
  ["ch04-smart-contracts-evm", "storage bytes32 commitment", "easy"],
  ["ch04-smart-contracts-evm", "storage string label", "easy"],
  ["ch04-smart-contracts-evm", "constructor sets owner from msg.sender", "easy"],
  ["ch04-smart-contracts-evm", "constructor with two args (name, symbol)", "easy"],
  ["ch04-smart-contracts-evm", "external view returning two values", "easy"],
  ["ch04-smart-contracts-evm", "pure function for math (square, cube)", "easy"],
  ["ch04-smart-contracts-evm", "modifier: onlyOwner", "easy"],
  ["ch04-smart-contracts-evm", "modifier: notZeroAddress", "easy"],
  ["ch04-smart-contracts-evm", "modifier: notPaused (with bool flag)", "easy"],
  ["ch04-smart-contracts-evm", "single event emit on state change", "easy"],
  ["ch04-smart-contracts-evm", "indexed event args (transfer-shape)", "easy"],
  ["ch04-smart-contracts-evm", "require with custom message", "easy"],
  ["ch04-smart-contracts-evm", "msg.sender + msg.value introspection", "easy"],
  ["ch04-smart-contracts-evm", "block.timestamp guard", "easy"],
  ["ch04-smart-contracts-evm", "block.number sanity", "easy"],
  ["ch04-smart-contracts-evm", "increment + decrement with underflow guard", "easy"],
  ["ch04-smart-contracts-evm", "simple add/subtract calculator", "easy"],
  ["ch04-smart-contracts-evm", "owner-renounce (set to zero address)", "easy"],
  ["ch04-smart-contracts-evm", "fallback function emits event", "easy"],
  ["ch04-smart-contracts-evm", "receive function logs deposit", "easy"],
  ["ch04-smart-contracts-evm", "address(this).balance read", "easy"],
  ["ch04-smart-contracts-evm", "constant + immutable variables", "easy"],

  // ── Medium (40): multi-function, mappings, modifiers, events ──
  ["ch04-smart-contracts-evm", "mapping(address => uint256) balance ledger", "medium"],
  ["ch04-smart-contracts-evm", "nested mapping (allowance: address => address => uint)", "medium"],
  ["ch04-smart-contracts-evm", "dynamic array push/pop with bounds", "medium"],
  ["ch04-smart-contracts-evm", "fixed-size array of recent depositors", "medium"],
  ["ch04-smart-contracts-evm", "struct array (tasks list with status)", "medium"],
  ["ch04-smart-contracts-evm", "mapping of structs (user profiles)", "medium"],
  ["ch04-smart-contracts-evm", "enum-driven state machine (Pending/Active/Closed)", "medium"],
  ["ch04-smart-contracts-evm", "modifier with parameter (minStake)", "medium"],
  ["ch04-smart-contracts-evm", "two-contract inheritance (Owned + Pausable)", "medium"],
  ["ch04-smart-contracts-evm", "interface + implementation (IFoo)", "medium"],
  ["ch04-smart-contracts-evm", "abstract base contract with hook", "medium"],
  ["ch04-smart-contracts-evm", "function overloading (deposit() vs deposit(uint))", "medium"],
  ["ch04-smart-contracts-evm", "virtual + override across two contracts", "medium"],
  ["ch04-smart-contracts-evm", "event with three indexed args + decoded via getLogs", "medium"],
  ["ch04-smart-contracts-evm", "custom error with named field payload", "medium"],
  ["ch04-smart-contracts-evm", "payable function gates on minimum value", "medium"],
  ["ch04-smart-contracts-evm", "withdraw pattern with pull model", "medium"],
  ["ch04-smart-contracts-evm", "transfer ETH to externally-supplied address", "medium"],
  ["ch04-smart-contracts-evm", "low-level call returning success bool", "medium"],
  ["ch04-smart-contracts-evm", "ERC-20 mint + transfer + balanceOf", "medium"],
  ["ch04-smart-contracts-evm", "ERC-20 approve + transferFrom flow", "medium"],
  ["ch04-smart-contracts-evm", "ERC-20 burn from caller", "medium"],
  ["ch04-smart-contracts-evm", "ERC-721 mint + ownerOf + transferFrom", "medium"],
  ["ch04-smart-contracts-evm", "ERC-721 approve + getApproved", "medium"],
  ["ch04-smart-contracts-evm", "timelock release after block.timestamp", "medium"],
  ["ch04-smart-contracts-evm", "two-step ownership transfer (claim pattern)", "medium"],
  ["ch04-smart-contracts-evm", "pausable contract with admin flip", "medium"],
  ["ch04-smart-contracts-evm", "checks-effects-interactions full demo", "medium"],
  ["ch04-smart-contracts-evm", "negative ints (int256) accounting", "medium"],
  ["ch04-smart-contracts-evm", "abi.encode + abi.decode round-trip", "medium"],
  ["ch04-smart-contracts-evm", "abi.encodePacked vs abi.encode hash difference", "medium"],
  ["ch04-smart-contracts-evm", "keccak256 of packed args matches off-chain", "medium"],
  ["ch04-smart-contracts-evm", "ecrecover signature verification", "medium"],
  ["ch04-smart-contracts-evm", "EIP-712 typed data hash builder", "medium"],
  ["ch04-smart-contracts-evm", "split contract into two and call across", "medium"],
  ["ch04-smart-contracts-evm", "event-driven counter (no return, just event)", "medium"],
  ["ch04-smart-contracts-evm", "ETH deposit + per-user withdraw with mapping", "medium"],
  ["ch04-smart-contracts-evm", "votable proposal: yes/no tally", "medium"],
  ["ch04-smart-contracts-evm", "subscription with monthly window", "medium"],
  ["ch04-smart-contracts-evm", "tip jar with leaderboard top-N tracking", "medium"],

  // ── Hard (25): proxies, gas, advanced patterns ──────────────
  ["ch04-smart-contracts-evm", "factory with create2 deterministic addresses", "hard"],
  ["ch04-smart-contracts-evm", "minimal proxy clone (EIP-1167)", "hard"],
  ["ch04-smart-contracts-evm", "transparent proxy with admin slot", "hard"],
  ["ch04-smart-contracts-evm", "UUPS upgrade with self-authorising upgrade fn", "hard"],
  ["ch04-smart-contracts-evm", "EIP-712 permit (off-chain sig, on-chain consume)", "hard"],
  ["ch04-smart-contracts-evm", "ERC-20 with EIP-2612 permit", "hard"],
  ["ch04-smart-contracts-evm", "n-of-m multisig wallet", "hard"],
  ["ch04-smart-contracts-evm", "constant-product AMM: add/remove liquidity", "hard"],
  ["ch04-smart-contracts-evm", "AMM swap with price impact", "hard"],
  ["ch04-smart-contracts-evm", "flash loan callback round-trip", "hard"],
  ["ch04-smart-contracts-evm", "vesting cliff + linear unlock with claim()", "hard"],
  ["ch04-smart-contracts-evm", "DAO proposal lifecycle (propose, vote, execute)", "hard"],
  ["ch04-smart-contracts-evm", "English auction with bidder refunds", "hard"],
  ["ch04-smart-contracts-evm", "Dutch auction (decreasing price over time)", "hard"],
  ["ch04-smart-contracts-evm", "commit-reveal scheme for fair lottery", "hard"],
  ["ch04-smart-contracts-evm", "merkle airdrop with proof verification", "hard"],
  ["ch04-smart-contracts-evm", "gas-efficient packed storage (3 fields in 1 slot)", "hard"],
  ["ch04-smart-contracts-evm", "assembly add with overflow check", "hard"],
  ["ch04-smart-contracts-evm", "inline assembly: read storage slot directly", "hard"],
  ["ch04-smart-contracts-evm", "delegatecall library for shared storage layout", "hard"],
  ["ch04-smart-contracts-evm", "reentrancy guard with mutex (cross-function)", "hard"],
  ["ch04-smart-contracts-evm", "CREATE2 + constructor immutable args", "hard"],
  ["ch04-smart-contracts-evm", "ERC-1155 batch-balance + batch-transfer", "hard"],
  ["ch04-smart-contracts-evm", "minimal ERC-4626 vault: deposit + redeem", "hard"],
  ["ch04-smart-contracts-evm", "mini governor: queue → delay → execute", "hard"],

  // ── Gap fills (post-curriculum-audit, 2026-05) ────────────────
  // Each entry targets a chapter the audit identified as
  // under-covered. All Solidity-harness exercises so they reuse the
  // existing chain.* harness; non-Solidity gaps (BIP-39, JSON-RPC,
  // ZK, scaling) are deferred to a separate non-EVM generator.

  // ch08-vyper — Vyper covers Solidity-equivalents; keeps the
  // "harness: evm" routing because the runtime compiles via Pyodide
  // and re-uses the same VM.
  ["ch08-smart-contracts-and-vyper", "vyper storage counter (port of Solidity)", "easy"],
  ["ch08-smart-contracts-and-vyper", "vyper onlyowner via @external + msg.sender check", "easy"],
  ["ch08-smart-contracts-and-vyper", "vyper bounded loops (no recursion)", "medium"],
  ["ch08-smart-contracts-and-vyper", "vyper ERC-20 minimal port", "medium"],
  ["ch08-smart-contracts-and-vyper", "vyper events with indexed args", "easy"],

  // ch09-security — three more security patterns the audit called out
  ["ch09-smart-contract-security", "tx.origin vs msg.sender (phishing trap fix)", "medium"],
  ["ch09-smart-contract-security", "front-running mitigation via commit-reveal", "hard"],
  ["ch09-smart-contract-security", "block.timestamp randomness pitfall demo", "medium"],
  ["ch09-smart-contract-security", "DoS via unbounded loop (gas-grief fix)", "medium"],
  ["ch09-smart-contract-security", "integer overflow check (pre-0.8 SafeMath replay)", "medium"],

  // ch11-oracles — most chapters need 4-5 lessons; this one's at 1
  ["ch11-oracles", "Chainlink-style price feed aggregator (mock)", "medium"],
  ["ch11-oracles", "request-response oracle with callback", "hard"],
  ["ch11-oracles", "median-aggregate three feeds", "medium"],
  ["ch11-oracles", "stale-price rejection by timestamp", "medium"],
  ["ch11-oracles", "mock VRF (verifiable randomness) consumer", "hard"],

  // ch12-dapps — governance/multisig done; add ENS + DApp glue
  ["ch12-decentralized-applications", "ENS namehash derivation (Solidity-side)", "medium"],
  ["ch12-decentralized-applications", "ENS resolver lookup against mock registry", "medium"],
  ["ch12-decentralized-applications", "viem-style read against deployed contract using chain.transport", "easy"],
  ["ch12-decentralized-applications", "viem-style write via walletClient against chain.transport", "medium"],
  ["ch12-decentralized-applications", "tic-tac-toe game contract with two players", "hard"],

  // ch13-defi — currently 6, target 8
  ["ch13-decentralized-finance", "lending market: deposit, borrow, accrue interest", "hard"],
  ["ch13-decentralized-finance", "stablecoin overcollateralized mint + redeem", "hard"],
  ["ch13-decentralized-finance", "merkle airdrop with claim flow", "medium"],

  // ch14-evm — bytecode-level lessons, currently 9
  ["ch14-the-evm", "yul function: add with overflow guard", "hard"],
  ["ch14-the-evm", "function selector decoder (msg.sig)", "medium"],
  ["ch14-the-evm", "extcodesize check for contract vs EOA", "medium"],
];

const SUPPORTED_DIFFICULTIES = new Set(["easy", "medium", "hard"]);

function readSettings() {
  if (!existsSync(SETTINGS_PATH))
    throw new Error(`settings.json not found at ${SETTINGS_PATH}`);
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
}

function loadCourse() {
  const dir = join(COURSES_DIR, COURSE_ID);
  const path = join(dir, "course.json");
  if (!existsSync(path)) throw new Error(`no course at ${path}`);
  return { dir, path, course: JSON.parse(readFileSync(path, "utf8")) };
}

const SYSTEM_PROMPT = `You author ONE chain-aware Solidity exercise for the Libre app's mastering-ethereum course. Each exercise compiles real Solidity, deploys it to an in-process EVM, and exercises real tx flows — NOT just ABI checks.

Return a single JSON object:

  {
    "title": "short descriptive title (≤ 60 chars)",
    "body": "markdown problem statement: what to build, signature shape, 1-2 examples, edge cases",
    "starter": "a complete .sol file with the contract scaffolded but the function bodies marked TODO. MUST compile (use trivial defaults like \`return 0;\` so solc is happy).",
    "solution": "the working .sol file — passes every test below",
    "tests": "JavaScript test code that uses the chain.* harness (see API below) — each test is wrapped in test('name', async () => { ... })",
    "hints": ["1-3 progressive hints"]
  }

THE chain HARNESS (always available in tests):

  // Pre-funded EOAs — same private keys as anvil prints. accounts[0] === chain.account.
  chain.account: { address: \`0x...\`, privateKey: \`0x...\` }
  chain.accounts: AccountHandle[10]

  // Deploy + interact
  const ctr = await chain.deploy("ContractName", [arg1, arg2], { value?: 1n * 10n**18n, from?: chain.accounts[1] });
  await ctr.read.<viewFn>(...args);          // returns ABI-decoded value
  const r = await ctr.write.<fn>(...args);   // returns { status, logs, events, gasUsed, blockNumber }
  const r = await ctr.write.<fn>(...args, { value: 1n * 10n**18n }); // attach ETH
  ctr.connect(otherAccount).write.<fn>(...); // re-bind sender

  // Asserts
  await chain.expectRevert(promise, "ExpectedErrorName");
  expect(value).toBe(0n);
  expect(value).toEqual([1n, 2n]);
  expect(value).toBeGreaterThan(0n);
  expect(value).toContain("substr");

  // Events
  const r = await ctr.write.transfer(...);
  expect(r.events).toEqual([{ eventName: "Transfer", args: { ... } }]);
  // OR via the global filter:
  const logs = await chain.getLogs({ abi, eventName: "Transfer" });

  // Multi-actor
  const alt = chain.accounts[1];
  const r = await ctr.connect(alt).write.deposit({ value: 10n ** 17n });

  // Time + blocks
  await chain.warp(86400);   // bump block.timestamp by 1 day
  await chain.mine(1);       // advance block.number
  chain.blockNumber();       // bigint
  chain.blockTimestamp();    // bigint

  // Money
  await chain.balanceOf(addr);                    // bigint
  await chain.setBalance(addr, 5n * 10n**18n);    // anvil/ganache convention

  // Snapshot + revert (for per-test isolation if needed)
  const snap = await chain.snapshot();
  // ... mutate state ...
  await chain.revert(snap);

WRITING RULES — NON-NEGOTIABLE:

  1. The starter MUST compile. Mark function bodies with \`// TODO\` + a trivial \`return 0;\` / empty body / etc. so solc emits valid bytecode and the test framework can deploy it (and at least one test fails cleanly against the stub instead of all tests crashing on a compile error).

  2. The solution MUST pass every test. Mentally run the tests against the solution before returning — if any assertion is unsatisfiable (e.g. you assert balance == 100 but the solution only writes 99), rewrite the test or the solution.

  3. ≥ 3 test cases minimum: a normal case, an edge case (boundary, zero, overflow, empty input as applicable), AND at least one revert/error case where appropriate.

  4. NO new contract names beyond what the starter declares. The deploy("Name") string must match the contract in the .sol file.

  5. Use BigInt literals (\`100n\`, \`10n ** 18n\`) for every numeric — Solidity uint values come back as bigint.

  6. Use viem-style chained reads: \`await counter.read.value()\` not \`await counter.value()\`.

  7. NO solidity.contracts[...].abi inspection in tests. The whole point of harness:evm is you deploy + call the bytecode. ABI checks belong in the legacy compile-only tests.

  8. NO importing libraries inside test code. The harness exposes exactly: \`compiled\`, \`chain\`, \`expect\`, \`test\`, \`console\`. (No viem, no ethers, no chai imports.)

  9. Keep contract sources self-contained — no \`import "@openzeppelin/...\"\`. The in-process compiler resolves only the user-supplied files. If you need ERC-20 semantics, write the relevant function inline.

  10. Solidity pragma: use \`pragma solidity ^0.8.26;\` to match the runtime's Cancun hardfork.

  11. SINGLE-FILE RULE — the workbench has exactly one .sol file. Every contract your tests reference via \`chain.deploy("Name", ...)\` MUST be defined in the \`solution\` field. If you need a mock/attacker/helper contract, paste it INLINE at the bottom of the same source. The runtime will compile all contracts in the file together; \`chain.deploy("Attacker")\` then resolves to the Attacker class in the same compilation unit. A test that deploys "Attacker" while the solution only has "Vault" will fail.

  12. ASSEMBLY RULE — when using \`assembly { ... }\` blocks, only use direct number constants for slot offsets (e.g. \`sload(0x360894...)\`). Solidity's inline assembly cannot dereference \`bytes32\` or \`uint\` storage variables directly inside assembly except via specific patterns (`Constant.slot`, computed from constants). When in doubt, define the slot as a \`bytes32 constant\` and reference it as \`MY_SLOT.slot\` would not work either — paste the literal hex in the assembly block.

  13. ADDRESS-CONTRACT CASTING — to cast an \`address\` to a contract type in 0.8.x:
        - For non-payable contracts: \`MyContract c = MyContract(addr);\`
        - For contracts WITH a payable fallback / receive: cast through \`payable\`: \`MyContract c = MyContract(payable(addr));\`
      Skipping the \`payable(...)\` wrapper triggers "Explicit type conversion not allowed from non-payable address to contract X, which has a payable fallback function".

DIFFICULTY GUIDE:
  easy   — single function, single state slot, ~10-25 lines of solution; tests do read+write+assert.
  medium — 2-4 functions, modifier or mapping or event, 25-60 lines; tests do multi-actor or revert.
  hard   — multiple contracts, time/block manipulation, gas accounting, or non-obvious invariants; 60-150 lines.

EXAMPLE — what a complete response looks like (storage variables, easy):

{
  "title": "Read and Write a uint256",
  "body": "## Storage 101\\n\\nImplement \`Storage\` with:\\n  - \`uint256 public stored\`\\n  - \`store(uint256 x)\` — sets \`stored = x\`\\n  - \`retrieve()\` returning \`stored\`\\n\\nThe public getter for \`stored\` is auto-generated by Solidity, so \`retrieve()\` is a deliberate duplicate to give you practice writing a view function.\\n\\nReverts: nothing here should revert.",
  "starter": "// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.26;\\n\\ncontract Storage {\\n    uint256 public stored;\\n\\n    function store(uint256 x) external {\\n        // TODO\\n    }\\n\\n    function retrieve() external view returns (uint256) {\\n        // TODO\\n        return 0;\\n    }\\n}\\n",
  "solution": "// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.26;\\n\\ncontract Storage {\\n    uint256 public stored;\\n\\n    function store(uint256 x) external { stored = x; }\\n    function retrieve() external view returns (uint256) { return stored; }\\n}\\n",
  "tests": "test('starts at zero', async () => {\\n  const s = await chain.deploy('Storage');\\n  expect(await s.read.stored()).toBe(0n);\\n  expect(await s.read.retrieve()).toBe(0n);\\n});\\n\\ntest('store writes the value', async () => {\\n  const s = await chain.deploy('Storage');\\n  await s.write.store(42n);\\n  expect(await s.read.stored()).toBe(42n);\\n  expect(await s.read.retrieve()).toBe(42n);\\n});\\n\\ntest('overwrite replaces, not accumulates', async () => {\\n  const s = await chain.deploy('Storage');\\n  await s.write.store(7n);\\n  await s.write.store(99n);\\n  expect(await s.read.stored()).toBe(99n);\\n});\\n",
  "hints": [
    "stored is a state variable — assign to it inside store().",
    "retrieve() returns the current value of stored — single line."
  ]
}

Return ONLY the JSON object. Begin with \`{\`, end with \`}\`. No markdown fences, no preamble.`;

async function callAnthropic({ apiKey, chapterId, topic, difficulty }) {
  const userPrompt = `Course: mastering-ethereum
Chapter: ${chapterId}
Topic: ${topic}
Difficulty: ${difficulty}

Generate one chain-aware Solidity exercise matching the constraints above. Return ONLY the JSON.`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "output-128k-2025-02-19",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (res.ok) {
      const body = await res.json();
      const text =
        body.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("") ?? "";
      return { text, usage: body.usage };
    }
    if (res.status === 429 || res.status >= 500) {
      const delay = 2000 * Math.pow(2, attempt);
      const errBody = await res.text().catch(() => "");
      console.warn(
        `  ⚠ ${res.status} on ${chapterId}/${topic}, retry in ${delay}ms (${errBody.slice(0, 80)})`,
      );
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  throw new Error(`exhausted retries for ${chapterId}/${topic}`);
}

function parseJsonTolerant(raw) {
  try {
    return JSON.parse(raw);
  } catch {}
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function slug(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "evm"
  );
}

function ensureChapter(course, chapterId, title) {
  let ch = course.chapters.find((c) => c.id === chapterId);
  if (!ch) {
    ch = { id: chapterId, title, lessons: [] };
    course.chapters.push(ch);
  }
  return ch;
}

async function runWithPool(items, concurrency, worker) {
  let next = 0;
  async function take() {
    while (next < items.length) {
      const i = next++;
      try {
        await worker(items[i], i);
      } catch (e) {
        console.warn(`  ✗ slot ${i}: ${e.message}`);
      }
    }
  }
  await Promise.all(
    Array(Math.min(concurrency, items.length))
      .fill(0)
      .map(take),
  );
}

async function main() {
  const settings = readSettings();
  const apiKey = settings.anthropic_api_key;
  if (!apiKey) throw new Error("no anthropic_api_key in settings.json");

  const handle = loadCourse();
  console.log(`[evm-gen] course ${COURSE_ID}`);
  console.log(`[evm-gen] model: ${MODEL}, concurrency: ${CONCURRENCY}`);
  console.log(`[evm-gen] PLAN size: ${PLAN.length}, COUNT: ${COUNT}`);

  const slots = PLAN.slice(START, START + COUNT)
    .filter(([, , d]) => SUPPORTED_DIFFICULTIES.has(d))
    .map(([chapterId, topic, difficulty], i) => ({
      chapterId,
      topic,
      difficulty,
      index: START + i,
    }));

  const existingIds = new Set(
    handle.course.chapters.flatMap((c) => c.lessons.map((l) => l.id)),
  );
  const nextId = (base) => {
    let id = base;
    let n = 2;
    while (existingIds.has(id)) {
      id = `${base}-${n++}`;
    }
    existingIds.add(id);
    return id;
  };

  if (DRY_RUN) {
    for (const s of slots) {
      console.log(`  [dry] ${s.chapterId}/${s.topic} (${s.difficulty})`);
    }
    return;
  }

  let totalIn = 0;
  let totalOut = 0;
  let savedSinceLast = 0;
  await runWithPool(slots, CONCURRENCY, async (slot) => {
    const tag = `${slot.chapterId}/${slot.topic}`;
    try {
      const { text, usage } = await callAnthropic({
        apiKey,
        chapterId: slot.chapterId,
        topic: slot.topic,
        difficulty: slot.difficulty,
      });
      totalIn += usage?.input_tokens || 0;
      totalOut += usage?.output_tokens || 0;
      const parsed = parseJsonTolerant(text);
      if (!parsed) {
        console.log(`  ✗ ${tag}: unparseable response`);
        return;
      }
      const idBase = `${slot.chapterId}-${slug(slot.topic)}`;
      const lesson = {
        id: nextId(idBase),
        kind: "exercise",
        title: parsed.title || `${slot.topic} (${slot.difficulty})`,
        body: parsed.body || "",
        language: "solidity",
        harness: "evm",
        difficulty: slot.difficulty,
        topic: slot.topic,
        starter: parsed.starter || "",
        solution: parsed.solution || "",
        tests: parsed.tests || "",
        hints: parsed.hints || [],
      };
      // Map chapter ids to display titles when creating new chapters.
      // Mirrors the 17-chapter book layout used by
      // scripts/restructure-mastering-ethereum.mjs.
      const chapterTitles = {
        "ch04-smart-contracts-evm": "Smart Contracts and the EVM",
        "ch07-contracts": "Smart Contracts",
        "ch08-smart-contracts-and-vyper": "Smart Contracts and Vyper",
        "ch09-smart-contract-security": "Smart Contract Security",
        "ch11-oracles": "Oracles",
        "ch12-decentralized-applications": "Decentralized Applications",
        "ch13-decentralized-finance": "Decentralized Finance",
        "ch14-the-evm": "The Ethereum Virtual Machine",
      };
      ensureChapter(
        handle.course,
        slot.chapterId,
        chapterTitles[slot.chapterId] || slot.chapterId,
      ).lessons.push(lesson);
      savedSinceLast++;
      if (savedSinceLast >= 3) {
        writeFileSync(
          handle.path,
          JSON.stringify(handle.course, null, 2),
          "utf-8",
        );
        savedSinceLast = 0;
      }
      console.log(`  ✓ ${tag} → ${lesson.title}`);
    } catch (e) {
      console.log(`  ✗ ${tag}: ${e.message}`);
    }
  });

  writeFileSync(handle.path, JSON.stringify(handle.course, null, 2), "utf-8");

  const PRICING = {
    "claude-sonnet-4-8": { in: 3, out: 15 },
    "claude-opus-4-8": { in: 15, out: 75 },
    "claude-haiku-4-8": { in: 1, out: 5 },
  };
  const p = PRICING[MODEL] || PRICING["claude-sonnet-4-8"];
  const usd = (totalIn / 1_000_000) * p.in + (totalOut / 1_000_000) * p.out;
  console.log(
    `\n[evm-gen] tokens in=${totalIn.toLocaleString()} out=${totalOut.toLocaleString()} ≈ $${usd.toFixed(2)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
