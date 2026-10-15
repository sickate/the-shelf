// Native fieldset semantics block every contained form control during async work.
export function metadataEditor(fieldset) {
  let ready = false,
    busy = false;
  fieldset.disabled = true;
  return {
    get ready() {
      return ready && !busy;
    },
    async load(operation) {
      ready = false;
      busy = true;
      fieldset.disabled = true;
      try {
        const result = await operation();
        ready = true;
        return result;
      } finally {
        busy = false;
        fieldset.disabled = !ready;
      }
    },
    async save(operation) {
      if (!ready || busy) return;
      busy = true;
      fieldset.disabled = true;
      try {
        return await operation();
      } finally {
        busy = false;
        fieldset.disabled = false;
      }
    },
  };
}
export function selectCategory(select, value) {
  if (!Array.from(select.options).some((option) => option.value === value)) {
    const option = select.ownerDocument.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = value;
}
