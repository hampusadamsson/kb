// Filter bar: free text, label chips, property chips, clear button.
import { chipInput, debounce } from "./dom.js";
import { hasFilters } from "./logic.js";

/** onChange({text, labels, props}) fires 250 ms after the last edit. */
export function createFilters(root, onChange) {
  const text = root.querySelector("#f-text");
  const clearBtn = root.querySelector("#f-clear");
  const emit = debounce(() => onChange({ text: text.value.trim(), labels: labels.get(), props: props.get() }), 250);
  const labels = chipInput({ label: "Label filter (! negates)", placeholder: "label, !label ⏎", onChange: emit });
  const props = chipInput({ label: "Property filter", placeholder: "key:value, !key ⏎", onChange: emit });
  root.querySelector("#f-labels").append(labels.el);
  root.querySelector("#f-props").append(props.el);
  text.addEventListener("input", emit);
  clearBtn.addEventListener("click", () => {
    emit.cancel();
    text.value = "";
    labels.set([]);
    props.set([]);
    onChange({ text: "", labels: [], props: [] });
  });
  return {
    /** Reflect URL state without firing onChange. */
    set(f) {
      emit.cancel();
      if (text.value.trim() !== f.text) text.value = f.text;
      labels.set(f.labels);
      props.set(f.props);
      clearBtn.hidden = !hasFilters(f);
    },
  };
}
