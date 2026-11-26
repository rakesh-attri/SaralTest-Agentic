// Behaviour of the fixture record pages (OFFLINE FIXTURE, Lightning-LIKE — not Salesforce markup).
// - Account page: "New" in the Contacts related list opens the New Contact dialog (Mailing Address defaults from the
//   Account's Billing Address, BRD BR-05 as implemented by this fixture). Save POSTs through the fixture REST API and,
//   as Lightning does, stays on the Account: the related list gets the new row and a success toast shows.
// - Contact page: "Edit" opens the Edit dialog pre-filled from the record; Save PATCHes it and reloads the page.
// - Every server error is shown: page-level ("We hit a snag.") plus field-level (aria-invalid + aria-describedby) for
//   each field the error names — required fields and the validation rules the fixture enforces.
// A short artificial delay with a spinner keeps tests honest about web-first waits (no sleeps).
(() => {
  const modal = document.querySelector('[role="dialog"]');
  const form = modal.querySelector('form');
  const pageError = modal.querySelector('.page-error');
  const spinner = document.querySelector('.spinner');
  const toast = document.querySelector('.toast');
  const fields = () => [...form.querySelectorAll('[data-field]')];
  const field = (name) => form.querySelector(`[data-field="${name}"]`);
  const REQUIRED_TEXT = 'Complete this field.';

  // ---- toast (survives the navigation after a create, like Lightning's)
  function showToast(text, variant) {
    toast.textContent = text;
    toast.dataset.variant = variant;
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  }
  const pending = sessionStorage.getItem('fixture-toast');
  if (pending) {
    sessionStorage.removeItem('fixture-toast');
    showToast(pending, 'success');
  }

  // ---- record tabs: one visible tabpanel at a time
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('[role="tab"]')) {
        const selected = t === tab;
        t.setAttribute('aria-selected', String(selected));
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !selected;
      }
    });
  }

  // ---- picklist combobox (lightning-combobox-like: button + listbox, options exist only while open)
  const combo = field('LeadSource');
  const listbox = combo ? document.getElementById(combo.getAttribute('aria-controls')) : null;
  function setPicklist(value) {
    combo.dataset.value = value ?? '';
    combo.textContent = value ? value : '--None--';
    for (const o of listbox.querySelectorAll('[role="option"]'))
      o.setAttribute('aria-selected', String(o.dataset.value === (value ?? '')));
  }
  function closeList() {
    listbox.hidden = true;
    combo.setAttribute('aria-expanded', 'false');
  }
  if (combo && listbox) {
    combo.addEventListener('click', () => {
      const open = listbox.hidden;
      listbox.hidden = !open;
      combo.setAttribute('aria-expanded', String(open));
    });
    for (const o of listbox.querySelectorAll('[role="option"]')) {
      o.addEventListener('click', () => {
        setPicklist(o.dataset.value);
        closeList();
        combo.focus();
      });
    }
  }

  // ---- errors
  function clearErrors() {
    pageError.hidden = true;
    for (const el of fields()) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
      const err = el.parentElement.querySelector('.field-error');
      if (err) {
        err.hidden = true;
        err.textContent = '';
      }
    }
  }
  function showErrors(errs) {
    const first = errs[0];
    pageError.querySelector('.page-error-detail').textContent = errs.map((e) => e.message).join(' ') || 'Unknown error';
    pageError.hidden = false;
    for (const e of errs) {
      for (const f of e.fields ?? []) {
        const el = field(f);
        const err = el?.parentElement.querySelector('.field-error');
        if (!el || !err) continue;
        const text = e.errorCode === 'REQUIRED_FIELD_MISSING' ? REQUIRED_TEXT : e.message;
        err.textContent = err.textContent ? `${err.textContent} ${text}` : text;
        err.hidden = false;
        el.setAttribute('aria-invalid', 'true');
        el.setAttribute('aria-describedby', err.id);
      }
    }
    return first;
  }

  // ---- open / close
  async function open() {
    form.reset();
    clearErrors();
    if (combo) setPicklist('');
    const acct = field('AccountName');
    if (acct) acct.value = form.dataset.accountName ?? '';
    if (form.dataset.mode === 'edit') {
      const res = await fetch(`/services/data/v62.0/sobjects/Contact/${form.dataset.recordId}`, {
        credentials: 'same-origin',
      });
      const rec = res.ok ? await res.json() : {};
      for (const el of fields()) {
        const name = el.dataset.field;
        if (name === 'AccountName') continue;
        if (name === 'LeadSource') setPicklist(rec.LeadSource ?? '');
        else el.value = rec[name] ?? '';
      }
    } else {
      const d = form.dataset;
      field('MailingStreet').value = d.billingStreet ?? '';
      field('MailingCity').value = d.billingCity ?? '';
      field('MailingPostalCode').value = d.billingPostalCode ?? '';
      field('MailingCountry').value = d.billingCountry ?? '';
    }
    modal.hidden = false;
    field('FirstName').focus();
  }
  function close() {
    modal.hidden = true;
    if (listbox) closeList();
  }

  document.querySelector('button[name="NewContact"]')?.addEventListener('click', open);
  document.querySelector('.record-header button[name="Edit"]')?.addEventListener('click', () => {
    if (form.dataset.mode === 'edit') void open();
  });
  form.querySelector('button[name="CancelEdit"]').addEventListener('click', close);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearErrors();
    const edit = form.dataset.mode === 'edit';
    const body = {};
    for (const el of fields()) {
      const name = el.dataset.field;
      if (name === 'AccountName') continue;
      const v = name === 'LeadSource' ? el.dataset.value : el.value.trim();
      if (edit) body[name] = v === '' ? null : v;
      else if (v) body[name] = v;
    }
    if (!edit) {
      body.LastName = body.LastName ?? '';
      body.AccountId = form.dataset.accountId;
    }
    spinner.hidden = false;
    await new Promise((r) => setTimeout(r, 300));
    const url = edit
      ? `/services/data/v62.0/sobjects/Contact/${form.dataset.recordId}`
      : '/services/data/v62.0/sobjects/Contact';
    const res = await fetch(url, {
      method: edit ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    spinner.hidden = true;
    if (!res.ok) {
      const errs = await res.json().catch(() => []);
      showErrors(Array.isArray(errs) ? errs : []);
      return;
    }
    const name = [body.FirstName, body.LastName].filter(Boolean).join(' ');
    if (edit) {
      sessionStorage.setItem('fixture-toast', `Contact "${name}" was saved.`);
      location.reload();
      return;
    }
    // As on live Lightning (qa-prod, run-p5-live-1): a Save from the related list STAYS on the Account page — the new
    // row appears in the Contacts related list and a toast confirms it. (Phase 5 had briefly navigated to the new
    // record here, from the specs' assumption rather than from an observation; corrected.)
    const created = await res.json();
    const tbody = document.querySelector('table[aria-label="Contacts"] tbody');
    const count = document.querySelector('.related-list .count');
    if (tbody) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      const a = document.createElement('a');
      a.href = `/lightning/r/Contact/${created.id}/view`;
      a.textContent = name;
      th.appendChild(a);
      const td = document.createElement('td');
      td.textContent = body.Email ?? '';
      tr.append(th, td);
      tbody.appendChild(tr);
    }
    if (count) count.textContent = String(Number(count.textContent) + 1);
    close();
    showToast(`Contact "${name}" was created.`, 'success');
  });
})();
