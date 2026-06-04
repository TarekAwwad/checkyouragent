import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom does not implement the native <dialog> modal methods. Stub them so
// components that call showModal()/close() can be exercised in tests, and
// reflect the open attribute so visibility queries behave as in a browser.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  });
}

afterEach(() => {
  cleanup();
});
