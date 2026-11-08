// On a phone an HTML email wider than the screen is shrunk to fit (zoom), as
// the Gmail app does, instead of scrolling sideways.
import { describe, expect, it } from "vitest";
import { fitZoom } from "../../emails/emailFitWidth";

function fakeDoc(contentWidth: number, frameWidth: number) {
  const doc = document.implementation.createHTMLDocument("email");
  Object.defineProperty(doc.documentElement, "scrollWidth", {
    value: contentWidth,
  });
  Object.defineProperty(doc.documentElement, "clientWidth", {
    value: frameWidth,
  });
  return doc;
}

describe("fitZoom", () => {
  it("shrinks a 600px email to a 360px phone frame", () => {
    expect(fitZoom(fakeDoc(600, 360))).toBeCloseTo(0.6);
  });

  it("leaves an email that already fits alone", () => {
    expect(fitZoom(fakeDoc(360, 360))).toBe(1);
    expect(fitZoom(fakeDoc(361, 360))).toBe(1);
  });

  it("never goes below the readable floor", () => {
    expect(fitZoom(fakeDoc(2000, 360))).toBe(0.4);
  });

  it("measures unzoomed, so a re-fit doesn't compound the zoom", () => {
    const doc = fakeDoc(600, 360);
    doc.body.style.setProperty("zoom", "0.6");
    fitZoom(doc);
    expect(doc.body.style.getPropertyValue("zoom")).toBe("");
  });
});
