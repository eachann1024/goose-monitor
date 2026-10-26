import { h } from "./atoms";

/** Shared form controls use the application's theme tokens. */
export function button(text: string, options: {
  primary?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
} = {}): HTMLButtonElement {
  return h("button", {
    className: `pk-button${options.primary ? " pk-button--primary" : ""}`,
    attrs: { type: options.type || "button" },
    text,
    on: options.onClick ? { click: options.onClick } : {},
  });
}

export function textControl<K extends "input" | "textarea">(
  tag: K,
  attrs: Record<string, string>,
): HTMLElementTagNameMap[K] {
  return h(tag, { className: "pk-input", attrs });
}

export function formField(label: string, control: HTMLInputElement | HTMLTextAreaElement): HTMLElement {
  return h("label", {
    className: "pk-field",
    children: [h("span", { className: "pk-field-label", text: label }), control],
  });
}

export function filePicker(options: { label: string; accept: string; limit: number; hint: string }) {
  const input = h("input", {
    attrs: { type: "file", hidden: "", accept: options.accept, "aria-label": options.label },
  });
  if (options.limit > 1) input.multiple = true;
  const choose = button(`选择${options.label}`, { onClick: () => input.click() });
  const list = h("div", { className: "pk-file-list", attrs: { "aria-live": "polite" } });
  function render() {
    const files = Array.from(input.files || []);
    choose.textContent = files.length ? `更换${options.label}` : `选择${options.label}`;
    list.replaceChildren(...files.map((file, index) => {
      const remove = button("×", { onClick: () => {
        const remaining = new DataTransfer();
        files.forEach((entry, position) => { if (position !== index) remaining.items.add(entry); });
        input.files = remaining.files;
        render();
      } });
      remove.classList.add("pk-file-remove");
      remove.setAttribute("aria-label", `移除 ${file.name}`);
      return h("div", {
        className: "pk-file",
        children: [h("span", { className: "pk-file-name", text: file.name, attrs: { title: file.name } }), remove],
      });
    }));
  }
  input.addEventListener("change", () => {
    if ((input.files?.length || 0) > options.limit) {
      const limited = new DataTransfer();
      Array.from(input.files || []).slice(0, options.limit).forEach((file) => limited.items.add(file));
      input.files = limited.files;
    }
    render();
  });
  return {
    input,
    reset() { input.value = ""; render(); },
    root: h("div", {
      className: "pk-field",
      children: [
        h("span", { className: "pk-field-label", text: options.label }),
        h("div", {
          className: "pk-file-picker",
          children: [choose, h("span", { className: "pk-file-hint", text: options.hint })],
        }),
        list,
        input,
      ],
    }),
  };
}
