/* Modal primitive: focus trap, Esc, backdrop click, focus restore, inert background.
   Also the promise-based confirm/prompt/message dialogs — window.confirm and friends
   block the whole renderer, so the app never uses them. */
const diaryDialog = (() => {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const stack = [];
  const inerted = new Set();
  let sequence = 0;

  const panelOf = (root) => root.querySelector('[role="dialog"]') || root;
  const rendered = (el) => Boolean(el.getClientRects().length);
  const focusable = (root) => [...panelOf(root).querySelectorAll(FOCUSABLE)].filter(rendered);

  /* Everything behind the topmost dialog stops taking focus and leaves the a11y tree.
     The toast is a live region, so it stays announceable. */
  function applyBackground() {
    for (const el of inerted) { el.inert = false; el.removeAttribute('aria-hidden'); }
    inerted.clear();
    if (!stack.length) return;
    const top = stack[stack.length - 1].root;
    for (const child of document.body.children) {
      if (child === top || child.matches('[aria-live], [role="status"]')) continue;
      child.inert = true;
      child.setAttribute('aria-hidden', 'true');
      inerted.add(child);
    }
  }

  function open(root, options = {}) {
    if (!root || stack.some(entry => entry.root === root)) return;
    const opener = options.opener || document.activeElement;
    stack.push({ root, opener, onClose: options.onClose });
    root.hidden = false;
    root.classList.add('open');
    applyBackground();
    const panel = panelOf(root);
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    const target = options.initialFocus || focusable(root)[0] || panel;
    target.focus();
  }

  function close(root) {
    const index = stack.findIndex(entry => entry.root === root);
    if (index === -1) return;
    const [entry] = stack.splice(index, 1);
    root.classList.remove('open');
    root.hidden = true;
    applyBackground();
    if (entry.opener && document.contains(entry.opener) && typeof entry.opener.focus === 'function') entry.opener.focus();
    if (entry.onClose) entry.onClose();
  }

  const isOpen = (root) => (root ? stack.some(entry => entry.root === root) : stack.length > 0);
  const closeTop = () => { if (stack.length) close(stack[stack.length - 1].root); };

  document.addEventListener('keydown', (event) => {
    if (!stack.length) return;
    const root = stack[stack.length - 1].root;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(root); return; }
    if (event.key !== 'Tab') return;
    const items = focusable(root);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    const outside = !root.contains(current);
    if (event.shiftKey && (outside || current === first)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (outside || current === last)) { event.preventDefault(); first.focus(); }
  }, true);

  document.addEventListener('pointerdown', (event) => {
    if (!stack.length) return;
    const root = stack[stack.length - 1].root;
    if (event.target === root) close(root);
  });

  /* Shared skeleton for the dialogs this module builds on the fly. */
  function build({ title, body, extra, className }) {
    const root = document.createElement('div');
    root.className = 'dialog-backdrop';
    const panel = document.createElement('div');
    panel.className = className;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const titleId = `diary-dialog-${++sequence}`;
    panel.setAttribute('aria-labelledby', titleId);
    const head = document.createElement('div');
    head.className = 'dialog-head';
    const heading = document.createElement('h2');
    heading.id = titleId;
    heading.textContent = title;
    head.append(heading);
    const content = document.createElement('div');
    content.className = 'dialog-body';
    for (const line of [].concat(body || []).filter(Boolean)) {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      content.append(paragraph);
    }
    if (extra) content.append(extra);
    const foot = document.createElement('div');
    foot.className = 'dialog-foot';
    panel.append(head, content, foot);
    root.append(panel);
    root.hidden = true;
    document.body.append(root);
    return { root, foot };
  }

  const button = (label, className) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = label;
    return node;
  };

  function confirm(options = {}) {
    return new Promise((resolve) => {
      const { root, foot } = build({
        title: options.title || 'Are you sure?',
        body: options.body,
        className: 'dialog confirm'
      });
      const cancel = button(options.cancelLabel || 'Cancel', 'btn');
      const accept = button(options.confirmLabel || 'Confirm', options.danger ? 'btn danger' : 'btn primary');
      foot.append(cancel, accept);
      let settled = false;
      const finish = (value) => {
        if (!settled) { settled = true; resolve(value); }
        close(root);
        root.remove();
      };
      cancel.addEventListener('click', () => finish(false));
      accept.addEventListener('click', () => finish(true));
      /* Destructive actions start on Cancel so a stray Enter cannot delete anything. */
      open(root, { initialFocus: options.danger ? cancel : accept, onClose: () => finish(false) });
    });
  }

  function prompt(options = {}) {
    return new Promise((resolve) => {
      const row = document.createElement('div');
      row.className = 'field-row';
      const label = document.createElement('label');
      label.className = 'field-label';
      label.id = `diary-prompt-label-${++sequence}`;
      label.textContent = options.label || 'Name';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'prompt-input';
      input.id = `diary-prompt-input-${sequence}`;
      input.value = options.value || '';
      input.autocomplete = 'off';
      label.htmlFor = input.id;
      row.append(label, input);

      /* An optional second row for choosing where the thing being named is stored. When
         options.picker is given the promise resolves to { name, dir } instead of a string,
         with dir empty meaning "the default location". */
      const picker = options.picker || null;
      let chosen = '';
      let paint = () => {};
      const extra = document.createElement('div');
      extra.append(row);
      if (picker) {
        const place = document.createElement('div');
        place.className = 'field-row picker-row';
        const placeLabel = document.createElement('span');
        placeLabel.className = 'field-label';
        placeLabel.textContent = picker.label || 'Location';
        const value = document.createElement('span');
        value.className = 'picker-path';
        const clear = button(picker.clearLabel || 'Reset', 'btn ghost picker-clear');
        const choose = button(picker.chooseLabel || 'Choose…', 'btn ghost');
        /* Shows the folder that will actually be created, not just the parent that was
           picked. "Stored in: ~/Nextcloud/ECON104" reads as though the notes land there,
           when the class becomes ECON104/ECON-104 inside it; spelling the whole path out
           is the only way that is not a guess. */
        paint = () => {
          const named = input.value.trim();
          const sep = chosen.includes('\\') && !chosen.includes('/') ? '\\' : '/';
          const full = chosen && named ? `${chosen}${sep}${named}` : chosen;
          value.textContent = full || picker.defaultLabel || 'Default location';
          value.title = full || '';
          value.classList.toggle('is-default', !chosen);
          clear.hidden = !chosen;
        };
        choose.addEventListener('click', async () => {
          const dir = await picker.onChoose();
          if (typeof dir === 'string' && dir) { chosen = dir; paint(); }
          input.focus();
        });
        clear.addEventListener('click', () => { chosen = ''; paint(); input.focus(); });
        paint();
        place.append(placeLabel, value, clear, choose);
        extra.append(place);
      }

      const { root, foot } = build({
        title: options.title || 'Name',
        body: options.body,
        extra,
        className: picker ? 'dialog confirm prompt has-picker' : 'dialog confirm prompt'
      });
      const cancel = button(options.cancelLabel || 'Cancel', 'btn');
      const accept = button(options.confirmLabel || 'Save', 'btn primary');
      foot.append(cancel, accept);

      let settled = false;
      const finish = (value) => {
        if (!settled) { settled = true; resolve(value); }
        close(root);
        root.remove();
      };
      const submit = () => {
        const value = input.value.trim();
        if (!value) { input.focus(); return; }
        finish(picker ? { name: value, dir: chosen } : value);
      };
      cancel.addEventListener('click', () => finish(null));
      accept.addEventListener('click', submit);
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submit();
      });
      /* The preview includes the folder name, so it follows what is typed. */
      if (picker) input.addEventListener('input', paint);
      open(root, { initialFocus: input, onClose: () => finish(null) });
      input.select();
    });
  }

  function message(options = {}) {
    return new Promise((resolve) => {
      const { root, foot } = build({
        title: options.title || 'daily-diary',
        body: options.body,
        className: 'dialog confirm'
      });
      const accept = button(options.confirmLabel || 'Close', 'btn primary');
      foot.append(accept);
      let settled = false;
      const finish = () => {
        if (!settled) { settled = true; resolve(); }
        close(root);
        root.remove();
      };
      accept.addEventListener('click', finish);
      open(root, { initialFocus: accept, onClose: finish });
    });
  }

  return { open, close, closeTop, isOpen, confirm, prompt, message };
})();

window.diaryDialog = diaryDialog;
