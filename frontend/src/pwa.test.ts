/** PWA shell checks: the hand-rolled service worker's routing logic and the
 * offline page. sw.js is a classic script served verbatim, so routeFor is
 * extracted by evaluating the file with a fake `self`. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const swSource = readFileSync("public/sw.js", "utf8");
const offlineSource = readFileSync("public/offline.html", "utf8");

type Route = "network" | "cache" | "navigate";

function routeFor(path: string, method = "GET", mode = "cors"): Route {
  const routed = new Function("self", `${swSource}; return routeFor;`)({ addEventListener: () => {} }) as (
    p: string,
    m: string,
    mo: string,
  ) => Route;
  return routed(path, method, mode);
}

describe("service worker", () => {
  it("exists and precaches the shell", () => {
    expect(swSource).toContain('"/offline.html"');
    expect(swSource).toContain("/site.webmanifest");
    expect(swSource).toContain("/icon-192.png");
  });

  it("keeps every /api/ call except covers out of the cache", () => {
    expect(routeFor("/api/v1/audio/ab/abcdef.mp3")).toBe("network");
    expect(routeFor("/api/v1/books")).toBe("network");
    expect(routeFor("/api/v1/books/1/progress")).toBe("network");
    expect(routeFor("/api/v1/events")).toBe("network");
    expect(routeFor("/api/v1/books/1/cover?v=deadbeef")).toBe("cache");
    expect(routeFor("/api/v1/books/1/cover")).toBe("cache");
  });

  it("never caches non-GET requests", () => {
    expect(routeFor("/api/v1/books", "POST")).toBe("network");
    expect(routeFor("/assets/app-abc123.js", "POST")).toBe("network");
  });

  it("cache-firsts built assets and falls back to the offline page on navigation", () => {
    expect(routeFor("/assets/index-abc123.js")).toBe("cache");
    expect(routeFor("/favicon.svg")).toBe("cache");
    expect(routeFor("/books/1", "GET", "navigate")).toBe("navigate");
  });
});

describe("offline page", () => {
  it("renders the brand shell without any JS bundles", () => {
    const doc = new DOMParser().parseFromString(offlineSource, "text/html");
    expect(doc.querySelector("h1")?.textContent).toBe("You're offline");
    const retry = doc.querySelector("button");
    expect(retry?.textContent).toBe("Retry");
    expect(retry?.getAttribute("onclick")).toContain("location.reload()");
    expect(doc.querySelector("script[src]")).toBeNull();
    expect(doc.querySelector("svg")).toBeTruthy();
    expect(doc.querySelector("style")?.textContent).toContain("#ffc233");
  });
});
