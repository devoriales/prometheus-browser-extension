import type { RuntimeRequest } from "../shared/protocol";
import {
  loadSecrets,
  loadSettings,
  matchPatternFor,
  normaliseBaseUrl,
  parseHeaderLines,
  saveSecrets,
  saveSettings,
  type PrometheusInstance,
  type Settings,
} from "../shared/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const inputs = {
  anthropicApiKey: $<HTMLInputElement>("anthropicApiKey"),
  gatewayBaseUrl: $<HTMLInputElement>("gatewayBaseUrl"),
  gatewayAuth: $<HTMLSelectElement>("gatewayAuth"),
  gatewayToken: $<HTMLInputElement>("gatewayToken"),
  gatewayHeaders: $<HTMLTextAreaElement>("gatewayHeaders"),
  model: $<HTMLInputElement>("model"),
  effort: $<HTMLSelectElement>("effort"),
  effortCc: $<HTMLSelectElement>("effortCc"),
  refusalFallback: $<HTMLInputElement>("refusalFallback"),
  claudeCodeModel: $<HTMLInputElement>("claudeCodeModel"),
  claudeCodeForceSubscription: $<HTMLInputElement>("claudeCodeForceSubscription"),
  validation: $<HTMLSelectElement>("validation"),
  insertMode: $<HTMLSelectElement>("insertMode"),
  inlineMetricLimit: $<HTMLInputElement>("inlineMetricLimit"),
  maxLabelValues: $<HTMLInputElement>("maxLabelValues"),
  maxToolRounds: $<HTMLInputElement>("maxToolRounds"),
  queryTimeoutSeconds: $<HTMLInputElement>("queryTimeoutSeconds"),
  customInstructions: $<HTMLTextAreaElement>("customInstructions"),
  responseMode: $<HTMLSelectElement>("responseMode"),
};
const instancesEl = $("instances");
const tpl = $<HTMLTemplateElement>("instanceTpl");

function provider(): Settings["provider"] {
  return (document.querySelector<HTMLInputElement>("input[name=provider]:checked")?.value ?? "anthropic") as Settings["provider"];
}

function showProviderFields(): void {
  const p = provider();
  document.querySelectorAll<HTMLElement>("[data-provider]").forEach((el) => {
    el.hidden = !el.dataset.provider!.split(" ").includes(p);
  });
}

function addInstanceCard(inst: Partial<PrometheusInstance>): void {
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.dataset.id = inst.id ?? crypto.randomUUID();
  for (const f of ["name", "baseUrl", "headers", "notes"] as const) {
    (node.querySelector(`[data-f=${f}]`) as HTMLInputElement).value = inst[f] ?? "";
  }
  node.querySelector("[data-act=remove]")!.addEventListener("click", () => node.remove());
  node.querySelector("[data-act=test]")!.addEventListener("click", () => void testInstance(node));
  instancesEl.appendChild(node);
}

function readInstances(): PrometheusInstance[] {
  return [...instancesEl.querySelectorAll<HTMLElement>(".instance")]
    .map((node) => {
      const get = (f: string) => (node.querySelector(`[data-f=${f}]`) as HTMLInputElement).value.trim();
      return { id: node.dataset.id!, name: get("name"), baseUrl: get("baseUrl"), headers: get("headers"), notes: get("notes") };
    })
    .filter((i) => i.baseUrl);
}

async function testInstance(node: HTMLElement): Promise<void> {
  const status = node.querySelector(".status") as HTMLElement;
  const get = (f: string) => (node.querySelector(`[data-f=${f}]`) as HTMLInputElement).value.trim();
  try {
    const base = normaliseBaseUrl(get("baseUrl"));
    if (!(await chrome.permissions.request({ origins: [matchPatternFor(base)] }))) throw new Error("Permission to access this host was denied.");
    const res = await fetch(`${base}api/v1/status/buildinfo`, { headers: parseHeaderLines(get("headers")), credentials: "include" });
    const body = await res.json().catch(() => null);
    if (body?.status === "success") setStatus(status, true, `Connected · Prometheus ${body.data?.version ?? ""}`);
    else {
      const names = await fetch(`${base}api/v1/label/__name__/values`, { headers: parseHeaderLines(get("headers")), credentials: "include" });
      const nb = await names.json().catch(() => null);
      if (nb?.status === "success") setStatus(status, true, `Connected · ${nb.data.length} metrics`);
      else throw new Error(`HTTP ${res.status}: not a Prometheus API at this URL (or you are not logged in)`);
    }
  } catch (err) {
    setStatus(status, false, (err as Error).message);
  }
}

function setStatus(el: HTMLElement, ok: boolean, text: string): void {
  el.className = `status ${ok ? "ok" : "err"}`;
  el.textContent = text;
}

function num(el: HTMLInputElement, fallback: number): number {
  const n = Number(el.value);
  return Number.isFinite(n) && el.value !== "" ? n : fallback;
}

async function save(): Promise<boolean> {
  const status = $("saveStatus");
  const current = await loadSettings();
  const instances = readInstances();
  try {
    for (const i of instances) i.baseUrl = normaliseBaseUrl(i.baseUrl);
  } catch {
    setStatus(status, false, "One of the Prometheus base URLs is not a valid URL.");
    return false;
  }
  const p = provider();
  const origins = instances.map((i) => matchPatternFor(i.baseUrl));
  if (p === "gateway" && inputs.gatewayBaseUrl.value.trim()) {
    try {
      origins.push(matchPatternFor(inputs.gatewayBaseUrl.value.trim()));
    } catch {
      setStatus(status, false, "The gateway URL is not a valid URL.");
      return false;
    }
  }
  if (origins.length && !(await chrome.permissions.request({ origins }))) {
    setStatus(status, false, "Saved nothing: the browser permission for these hosts was denied.");
    return false;
  }

  const settings: Settings = {
    ...current,
    provider: p,
    model: inputs.model.value.trim() || "claude-opus-5-5",
    effort: (p === "claude-code" ? inputs.effortCc.value : inputs.effort.value) as Settings["effort"],
    gatewayBaseUrl: inputs.gatewayBaseUrl.value.trim(),
    gatewayAuth: inputs.gatewayAuth.value as Settings["gatewayAuth"],
    gatewayHeaders: inputs.gatewayHeaders.value,
    refusalFallback: inputs.refusalFallback.checked,
    claudeCodeModel: inputs.claudeCodeModel.value.trim(),
    claudeCodeForceSubscription: inputs.claudeCodeForceSubscription.checked,
    instances,
    validation: inputs.validation.value as Settings["validation"],
    insertMode: inputs.insertMode.value as Settings["insertMode"],
    inlineMetricLimit: num(inputs.inlineMetricLimit, current.inlineMetricLimit),
    maxLabelValues: num(inputs.maxLabelValues, current.maxLabelValues),
    maxToolRounds: num(inputs.maxToolRounds, current.maxToolRounds),
    queryTimeoutSeconds: num(inputs.queryTimeoutSeconds, current.queryTimeoutSeconds),
    customInstructions: inputs.customInstructions.value,
    responseMode: inputs.responseMode.value as Settings["responseMode"],
  };
  await saveSettings(settings);
  await saveSecrets({ anthropicApiKey: inputs.anthropicApiKey.value.trim(), gatewayToken: inputs.gatewayToken.value.trim() });
  await chrome.runtime.sendMessage({ type: "syncContentScripts" } satisfies RuntimeRequest);
  setStatus(status, true, "Saved. Reload open Prometheus tabs to see the assistant.");
  return true;
}

async function init(): Promise<void> {
  const [settings, secrets] = await Promise.all([loadSettings(), loadSecrets()]);
  (document.querySelector(`input[name=provider][value="${settings.provider}"]`) as HTMLInputElement).checked = true;
  inputs.anthropicApiKey.value = secrets.anthropicApiKey;
  inputs.gatewayToken.value = secrets.gatewayToken;
  inputs.gatewayBaseUrl.value = settings.gatewayBaseUrl;
  inputs.gatewayAuth.value = settings.gatewayAuth;
  inputs.gatewayHeaders.value = settings.gatewayHeaders;
  inputs.model.value = settings.model;
  inputs.effort.value = settings.effort;
  inputs.effortCc.value = settings.effort;
  inputs.refusalFallback.checked = settings.refusalFallback;
  inputs.claudeCodeModel.value = settings.claudeCodeModel;
  inputs.claudeCodeForceSubscription.checked = settings.claudeCodeForceSubscription;
  inputs.validation.value = settings.validation;
  inputs.insertMode.value = settings.insertMode;
  inputs.inlineMetricLimit.value = String(settings.inlineMetricLimit);
  inputs.maxLabelValues.value = String(settings.maxLabelValues);
  inputs.maxToolRounds.value = String(settings.maxToolRounds);
  inputs.queryTimeoutSeconds.value = String(settings.queryTimeoutSeconds);
  inputs.customInstructions.value = settings.customInstructions;
  inputs.responseMode.value = settings.responseMode;
  settings.instances.forEach(addInstanceCard);

  const add = new URLSearchParams(location.search).get("add");
  if (add && !settings.instances.some((i) => i.baseUrl === add)) {
    addInstanceCard({ name: new URL(add).hostname, baseUrl: add });
    instancesEl.lastElementChild?.scrollIntoView({ behavior: "smooth" });
  }
  if (!instancesEl.children.length) addInstanceCard({});

  $("bridgeCmd").textContent = `npm run bridge:install -- --extension-id ${chrome.runtime.id}`;
  document.querySelectorAll("input[name=provider]").forEach((r) => r.addEventListener("change", showProviderFields));
  showProviderFields();

  $("addInstance").addEventListener("click", () => addInstanceCard({}));
  $("save").addEventListener("click", () => void save());
  $("testProvider").addEventListener("click", async () => {
    const status = $("providerStatus");
    status.className = "status";
    status.textContent = "Saving and testing…";
    if (!(await save())) return;
    const res = (await chrome.runtime.sendMessage({ type: "testProvider" } satisfies RuntimeRequest)) as { ok: boolean; message: string };
    setStatus(status, res.ok, res.message);
  });
}

void init();
