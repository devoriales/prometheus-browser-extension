import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/shared/markdown";
import { findInstance, guessBaseUrl, matchPatternFor, normaliseBaseUrl, parseHeaderLines } from "../src/shared/settings";
import { ACTION_SCHEMA, environmentBlock, toolSpecs, userMessage } from "../src/shared/prompt";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

const inst = (id: string, baseUrl: string) => ({ id, name: id, baseUrl, headers: "", notes: "" });

describe("settings helpers", () => {
  it("guesses the base URL from UI routes, keeping route prefixes", () => {
    expect(guessBaseUrl("https://prom.example.com/query?g0.expr=up")).toBe("https://prom.example.com/");
    expect(guessBaseUrl("https://example.com/prometheus/graph")).toBe("https://example.com/prometheus/");
    expect(guessBaseUrl("http://localhost:9090/alerts")).toBe("http://localhost:9090/");
  });
  it("matches the longest configured prefix", () => {
    const list = [inst("root", "https://example.com/"), inst("prom", "https://example.com/prometheus")];
    expect(findInstance(list, "https://example.com/prometheus/query")?.id).toBe("prom");
    expect(findInstance(list, "https://example.com/grafana/")?.id).toBe("root");
    expect(findInstance(list, "https://other.com/query")).toBeUndefined();
  });
  it("builds port-less match patterns and normalises URLs", () => {
    expect(matchPatternFor("http://localhost:9090/x/")).toBe("http://localhost/*");
    expect(normaliseBaseUrl("https://a.com/prom?x=1#y")).toBe("https://a.com/prom/");
  });
  it("parses header lines", () => {
    expect(parseHeaderLines("X-Scope-OrgID: tenant-a\n\nbad line\nAuthorization: Bearer a:b")).toEqual({
      "X-Scope-OrgID": "tenant-a",
      Authorization: "Bearer a:b",
    });
  });
});

describe("prompt", () => {
  it("drops run_query when validation is off and keeps strict-compatible schemas", () => {
    expect(toolSpecs("off").map((t) => t.name)).toEqual(["search_metrics", "get_metric_labels", "submit_query"]);
    for (const t of toolSpecs("execute")) {
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.input_schema.required.sort()).toEqual(Object.keys(t.input_schema.properties).sort());
    }
    expect(ACTION_SCHEMA.properties.action.enum).toContain("submit_query");
  });
  it("puts the editor query in the user message, not the cached system prompt", () => {
    const ctx = { instanceId: "a", pageUrl: "", currentQuery: "up", prometheusVersion: "3.0.0", metricCount: 2, inlineMetrics: "up gauge\nfoo counter", validation: "execute" as const, mode: "concise" as const };
    expect(userMessage("fix it", ctx)).toContain("```promql\nup\n```");
    expect(userMessage("fix it", ctx)).toContain("Response style: concise");
    expect(userMessage("fix it", { ...ctx, mode: "educational" })).toContain("Response style: educational");
    const env = environmentBlock(DEFAULT_SETTINGS, inst("a", "http://x/"), ctx);
    expect(env).toContain("foo counter");
    expect(env).not.toContain("fix it");
  });
});

describe("renderMarkdown", () => {
  it("escapes HTML before formatting", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **bold** `a<b`\n\n```promql\nsum(x) > 1\n```');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>a&lt;b</code>");
    expect(html).toContain("<pre>sum(x) &gt; 1</pre>");
  });
  it("renders bullet lists", () => {
    expect(renderMarkdown("Parts:\n- `rate()` per second\n- **sum** by job")).toBe(
      "<p>Parts:</p><ul><li><code>rate()</code> per second</li><li><strong>sum</strong> by job</li></ul>",
    );
  });
});
