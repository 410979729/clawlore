import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { evaluateCaptureSafety } = jiti("../src/capture-safety.ts");
const { isNoise } = jiti("../src/noise-filter.ts");
const {
  containsSecret,
  findSecret,
  redactKnownSecrets,
} = jiti("../src/secret-redaction.ts");

test("capture safety blocks Chinese credential assignments", () => {
  const decision = evaluateCaptureSafety("远程登录密码是 CorrectHorse77!");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "secret");
  assert.equal(decision.pattern, "chinese-password-assignment");
});

test("capture safety blocks credential pairs", () => {
  const decision = evaluateCaptureSafety("用户名是 deploy，密码是 CorrectHorse77!");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "secret");
  assert.equal(decision.pattern, "credential-pair-with-password");
});

test("capture safety treats redacted credential placeholders as non-secret", () => {
  const decision = evaluateCaptureSafety("用户名是 [REDACTED]，密码是 [REDACTED]");
  assert.equal(decision.allowed, true);
});

test("secret detection scans every match and only exempts whole placeholder tokens", () => {
  const real = "RealSecret123";
  const cases = [
    [`password=changeme password=${real}`, true],
    [`password=${real} password=changeme`, true],
    [`password=MyExamplePass123`, true],
    [`password=changeme`, false],
    [`api_key=YOUR_API_KEY_PLACEHOLDER`, false],
  ];
  for (const [value, expected] of cases) {
    assert.equal(containsSecret(value), expected, value);
    assert.equal(Boolean(findSecret(value)), expected, value);
    assert.equal(evaluateCaptureSafety(value).allowed, !expected, value);
  }
  assert.equal(redactKnownSecrets(`password=changeme password=${real}`).includes(real), false);
});

test("capture safety blocks common provider secrets and alphanumeric passwords", () => {
  const cases = [
    [`${"sk"}_live_${"A".repeat(24)}`, "stripe-secret-key"],
    [`${"glpat"}-${"b".repeat(24)}`, "gitlab-token"],
    [`${"ya29"}.${"c".repeat(24)}`, "google-oauth-token"],
    [`${"SG"}.${"d".repeat(20)}.${"e".repeat(24)}`, "sendgrid-key"],
    [`npm_${"A".repeat(36)}`, "npm-token"],
    [`pypi-${"B".repeat(48)}`, "pypi-token"],
    [`hf_${"C".repeat(24)}`, "huggingface-token"],
    [`dop_v1_${"d".repeat(64)}`, "digitalocean-token"],
    [`12345678:${"E".repeat(35)}`, "telegram-bot-token"],
    [`password=${"hunter2admin"}`, "password-assignment-unquoted"],
  ];
  for (const [value, pattern] of cases) {
    const decision = evaluateCaptureSafety(`credential ${value}`);
    assert.equal(decision.allowed, false, pattern);
    assert.equal(decision.reason, "secret", pattern);
    assert.equal(decision.pattern, pattern);
  }
});

test("secret policy blocks env-style credentials and credential-bearing HTTP headers", () => {
  const cases = [
    ["DB_PASSWORD=CorrectHorse77!", "env-secret-assignment"],
    ["SERVICE_TOKEN=service-token-value-123", "env-secret-assignment"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "authorization-basic"],
    ["Cookie: session_id=session-value-123; theme=dark", "http-cookie-header"],
    ["Set-Cookie: session_id=session-value-456; Secure; HttpOnly", "http-cookie-header"],
  ];
  for (const [value, pattern] of cases) {
    assert.equal(containsSecret(value), true, value);
    assert.equal(findSecret(value)?.name, pattern, value);
    assert.equal(evaluateCaptureSafety(value).allowed, false, value);
    assert.equal(redactKnownSecrets(value).includes("session-value"), false, value);
  }
  assert.equal(containsSecret("DB_PASSWORD=changeme"), false);
});

test("secret policy blocks namespaced YAML and JSON credential assignments", () => {
  const cases = [
    ["DB_PASSWORD: CorrectHorse77!", "structured-secret-assignment"],
    ['"DB_PASSWORD": "CorrectHorse77!"', "structured-secret-assignment"],
    ["config: { SERVICE_TOKEN: service-token-value-123 }", "structured-secret-assignment"],
  ];
  for (const [value, pattern] of cases) {
    assert.equal(containsSecret(value), true, value);
    assert.equal(findSecret(value)?.name, pattern, value);
    assert.equal(evaluateCaptureSafety(value).allowed, false, value);
    assert.doesNotMatch(redactKnownSecrets(value), /CorrectHorse77|service-token-value-123/, value);
  }
  assert.equal(containsSecret("DB_PASSWORD: changeme"), false);
});

test("secret policy parses camelCase keys, quoted values, and YAML block scalars", () => {
  const cases = [
    ['{"databasePassword":"Synthetic Value With Spaces 123"}', "Synthetic Value With Spaces 123"],
    ['{"serviceToken":"synthetic-token-value-123"}', "synthetic-token-value-123"],
    ["DB_PASSWORD: >-\n  synthetic block value line one\n  line two\nsafe: ok", "synthetic block value line one"],
    ['config: { serviceToken: "synthetic token with spaces" }', "synthetic token with spaces"],
  ];
  for (const [value, secretValue] of cases) {
    assert.equal(containsSecret(value), true, value);
    assert.equal(findSecret(value)?.name, "structured-secret-assignment", value);
    assert.equal(evaluateCaptureSafety(value).allowed, false, value);
    assert.equal(redactKnownSecrets(value).includes(secretValue), false, value);
  }

  assert.equal(containsSecret('passwordPolicy: "minimum 12 characters"'), false);
  assert.equal(containsSecret("tokenCount: 512"), false);
});

test("embedded YAML block scalars redact both indicator orders and header comments", () => {
  const samples = [
    "embedded config databasePassword: |2- # operator note\n    synthetic block value one\nnext: safe",
    "embedded config serviceToken: |-2\n    synthetic block value two\nnext: safe",
  ];
  for (const sample of samples) {
    assert.equal(containsSecret(sample), true);
    const redacted = redactKnownSecrets(sample);
    assert.doesNotMatch(redacted, /synthetic block value/u);
    assert.match(redacted, /\[REDACTED_STRUCTURED_SECRET_ASSIGNMENT\]/u);
    assert.match(redacted, /next: safe/u);
  }
});

test("secret policy resolves YAML aliases, covers authorization schemes, and redacts idempotently", () => {
  const aliasSecret = "SyntheticAliasSecret123";
  const yaml = [
    `shared: &credential ${aliasSecret}`,
    "password: *credential",
    "safe: ok",
    "",
  ].join("\n");
  const digestSecret = "SyntheticDigestSecret123";
  const nestedHeader = JSON.stringify({
    log: `Authorization: Digest username=\"demo\", response=\"${digestSecret}\"`,
  });
  const nestedConfig = JSON.stringify({
    l0_abstract: `serviceToken: ${digestSecret}`,
  });

  for (const [value, secretValue] of [[yaml, aliasSecret], [nestedHeader, digestSecret], [nestedConfig, digestSecret]]) {
    assert.equal(containsSecret(value), true, value);
    const once = redactKnownSecrets(value);
    assert.equal(once.includes(secretValue), false, value);
    assert.equal(redactKnownSecrets(once), once, value);
    assert.equal(containsSecret(once), false, value);
    assert.doesNotMatch(once, /\]\]/, value);
  }
});

test("secret policy covers CJK and cryptographic key names without partial redaction", () => {
  const secretValue = "Synthetic Value With Spaces 123";
  const cases = [
    JSON.stringify({ 密码: secretValue }),
    `访问令牌: "${secretValue}"`,
    JSON.stringify({ signingKey: secretValue }),
    `encryption_key: "${secretValue}"`,
    `masterKey: "${secretValue}"`,
    `hmacKey: "${secretValue}"`,
    `secretKey: "${secretValue}"`,
    `keystorePassphrase: "${secretValue}"`,
    `recoveryCode: "${secretValue}"`,
    `prefix text; 密码: "${secretValue}"; safe: ok`,
  ];
  for (const value of cases) {
    assert.equal(containsSecret(value), true, value);
    const redacted = redactKnownSecrets(value);
    assert.equal(redacted.includes(secretValue), false, value);
    assert.equal(redacted.includes("Value With Spaces 123"), false, value);
    assert.equal(redactKnownSecrets(redacted), redacted, value);
  }
  assert.equal(containsSecret('publicKey: "ordinary public material"'), false);
  assert.equal(containsSecret('keyboardKey: "ordinary shortcut name"'), false);
});

test("OpenClaw session identity keys remain metadata while session secrets stay blocked", () => {
  const runtimeSession = "agent:main:telegram:default:direct:8176453077";
  assert.equal(containsSecret(JSON.stringify({ sessionKey: runtimeSession })), false);
  assert.equal(containsSecret(JSON.stringify({ session_key: runtimeSession })), false);
  for (const key of ["sessionSecret", "sessionSigningKey", "sessionEncryptionKey"]) {
    const value = JSON.stringify({ [key]: "Synthetic Session Secret Value 123" });
    assert.equal(containsSecret(value), true, key);
    assert.equal(redactKnownSecrets(value).includes("Synthetic Session Secret Value 123"), false, key);
  }
});

test("secret policy covers XML, TOML multiline values, and command-line credentials", () => {
  const secretValue = "Synthetic Cross Format Secret 123";
  const cases = [
    `<settings><databasePassword>${secretValue}</databasePassword></settings>`,
    `<token><![CDATA[${secretValue}]]></token>`,
    `password = \"\"\"${secretValue}\nsecond line\"\"\"`,
    `tool --password \"${secretValue}\" --safe true`,
    "tool --token=SyntheticCliToken123 --safe true",
    "curl --user demo:SyntheticBasicPassword123 https://example.invalid",
    `Authorization: Bearer \"${secretValue}\"`,
  ];
  for (const value of cases) {
    assert.equal(containsSecret(value), true, value);
    const redacted = redactKnownSecrets(value);
    assert.equal(redacted.includes(secretValue), false, value);
    assert.doesNotMatch(redacted, /Synthetic(?:CliToken|BasicPassword)/, value);
    assert.equal(redactKnownSecrets(redacted), redacted, value);
  }
});

test("secret policy covers XML key/value attributes and npmrc registry credentials", () => {
  const positives = [
    ['<add key="ClientSecret" value="SyntheticXmlSecret123" />', "SyntheticXmlSecret123"],
    ["<add name='apiToken' value='SyntheticXmlToken456' />", "SyntheticXmlToken456"],
    ["<service clientSecret=SyntheticDirectAttribute789 />", "SyntheticDirectAttribute789"],
    ["//registry.npmjs.org/:_authToken=SyntheticNpmToken123", "SyntheticNpmToken123"],
    ["//npm.pkg.github.com/:_auth='SyntheticNpmAuth456'", "SyntheticNpmAuth456"],
    ["_authToken = SyntheticDefaultRegistry789", "SyntheticDefaultRegistry789"],
  ];
  for (const [value, secret] of positives) {
    assert.equal(containsSecret(value), true, value);
    const redacted = redactKnownSecrets(value);
    assert.equal(redacted.includes(secret), false, value);
    assert.equal(redactKnownSecrets(redacted), redacted, value);
  }

  for (const value of [
    '<add key="RetryCount" value="5" />',
    "@scope:registry=https://registry.npmjs.org/",
    '<add key="ClientSecret" value="${CLIENT_SECRET}" />',
    "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
  ]) {
    assert.equal(containsSecret(value), false, value);
    assert.equal(redactKnownSecrets(value), value, value);
  }
});

test("capture safety blocks operational trace wrappers", () => {
  const decision = evaluateCaptureSafety(
    "Command hints:\n- inspect logs\nFiles:\n/tmp/x.log\nResult: Command completed | status=completed",
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "operational-trace");
});

test("capture safety blocks raw tool output dumps", () => {
  const decision = evaluateCaptureSafety(
    '```json\n{"tool_call_id":"call_123","wall_time_seconds":1.2,"stdout":"secret-looking output"}\n```',
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "operational-trace");
  assert.equal(decision.pattern, "tool-call-json");
});

test("capture safety blocks private credential paths", () => {
  const decision = evaluateCaptureSafety(
    "The deploy credential is referenced by /home/a/openclaw-tianji/home/state/workspace/.credentials/deploy.txt",
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "private-path");
  assert.equal(decision.pattern, "credentials-path");
});

test("capture safety blocks ephemeral assistant progress noise", () => {
  const decision = evaluateCaptureSafety("我现在开始排查 scope-recall 插件的运行状态。");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "progress-noise");
});

test("noise filter rejects raw user task prompts", () => {
  assert.equal(isNoise("你去检查一下天姬记忆库，看看 SQL 记忆质量"), true);
});

test("high-signal distilled memory remains admissible", () => {
  const text = "天姬记忆治理经验：ClawLore 需要先审计 SQLite/FTS/LanceDB 一致性，再做高密度蒸馏并同步向量库。";
  assert.equal(evaluateCaptureSafety(text).allowed, true);
  assert.equal(isNoise(text), false);
});
