import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

test("plan header never paints its chevron or labels over adjacent controls", async t => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 500 } });
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  // Isolate the actual stylesheet with the same toolbar structure as PlanPanel.
  // This checks browser layout without compiling or launching Pi Desktop.
  for (const width of [260, 280, 320, 360, 480, 760]) {
    for (const state of ["paused", "active", "complete", "collapsed"]) {
      const heading = state === "complete" ? "План выполнен" : "Рабочий план";
      const control = state === "complete" ? "" : `<button class="plan-control">${state === "active" ? "Пауза" : "Продолжить"}</button>`;
      const current = state === "collapsed" ? '<span class="plan-current">Инвентаризация конструктора, экранов и библиотек</span>' : "";
      await page.setContent(`<style>${css}</style><section class="plan-panel" style="width:${width}px"><div class="plan-toolbar"><button class="plan-heading"><svg width="17" height="17"></svg><strong>${heading}</strong><span class="plan-count">${state === "complete" ? "16" : "10"} / 16</span>${current}<svg width="15" height="15" class="plan-chevron${state === "collapsed" ? "" : " expanded"}"></svg></button>${control}<button class="plan-remove"><svg width="15" height="15"></svg></button></div></section>`);
      const geometry = await page.evaluate(() => {
        const heading = document.querySelector(".plan-heading");
        const box = node => {
          const r = node.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        return {
          heading: box(heading),
          children: [...heading.children].map(box),
          toolbar: box(document.querySelector(".plan-toolbar")),
          control: document.querySelector(".plan-control") ? box(document.querySelector(".plan-control")) : null,
          remove: box(document.querySelector(".plan-remove")),
          title: { scroll: heading.querySelector("strong").scrollWidth, client: heading.querySelector("strong").clientWidth },
        };
      });
      for (const child of geometry.children) {
        assert.ok(child.left >= geometry.heading.left - 1 && child.right <= geometry.heading.right + 1, `${width}/${state}: heading child escaped horizontally`);
        assert.ok(child.top >= geometry.heading.top - 1 && child.bottom <= geometry.heading.bottom + 1, `${width}/${state}: heading child escaped vertically`);
      }
      assert.ok(geometry.title.scroll <= geometry.title.client + 1, `${width}/${state}: title text is clipped`);
      assert.ok(geometry.heading.right <= (geometry.control ?? geometry.remove).left + 1, `${width}/${state}: controls overlap`);
      assert.ok(geometry.remove.right <= geometry.toolbar.right + 1, `${width}/${state}: remove control escaped`);
    }
  }
  t.diagnostic("24 combinations of width and plan state checked");
});
