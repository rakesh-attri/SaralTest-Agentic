// Behaviour of the fixture record page: open the New Contact modal, validate, save through the fixture REST API
// (session cookie), show a Lightning-like toast, update the related list. Includes a short artificial delay with a
// spinner so tests must use web-first waits (no sleeps).
(() => {
  const modal = document.querySelector('[role="dialog"]');
  const form = modal.querySelector('form');
  const pageError = modal.querySelector('.page-error');
  const spinner = document.querySelector('.spinner');
  const toast = document.querySelector('.toast');
  const tbody = document.querySelector('table[aria-label="Contacts"] tbody');
  const count = document.querySelector('.related-list .count');
  const lastNameInput = form.querySelector('input[name="lastName"]');
  const lastNameErr = lastNameInput.parentElement.querySelector('.field-error');

  function open() {
    form.reset();
    form.querySelector('input[name="account"]').value = form.dataset.accountName;
    pageError.hidden = true;
    lastNameErr.hidden = true;
    lastNameInput.removeAttribute('aria-invalid');
    lastNameInput.removeAttribute('aria-describedby');
    modal.hidden = false;
    form.querySelector('input[name="firstName"]').focus();
  }
  function close() {
    modal.hidden = true;
  }
  function showToast(text, variant) {
    toast.textContent = text;
    toast.dataset.variant = variant;
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  }

  document.querySelector('button[name="NewContact"]')?.addEventListener('click', open);
  form.querySelector('button[name="CancelEdit"]').addEventListener('click', close);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const firstName = form.firstName.value.trim();
    const lastName = form.lastName.value.trim();
    const email = form.email.value.trim();
    const body = { LastName: lastName, AccountId: form.dataset.accountId };
    if (firstName) body.FirstName = firstName;
    if (email) body.Email = email;
    spinner.hidden = false;
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch('/services/data/v62.0/sobjects/Contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    spinner.hidden = true;
    if (!res.ok) {
      const errs = await res.json().catch(() => []);
      const first = Array.isArray(errs) ? errs[0] : undefined;
      pageError.querySelector('.page-error-detail').textContent = first?.message ?? 'Unknown error';
      pageError.hidden = false;
      if (first?.fields?.includes('LastName')) {
        lastNameErr.hidden = false;
        lastNameInput.setAttribute('aria-invalid', 'true');
        lastNameInput.setAttribute('aria-describedby', lastNameErr.id);
      }
      return;
    }
    const created = await res.json();
    const name = [firstName, lastName].filter(Boolean).join(' ');
    const tr = document.createElement('tr');
    const a = document.createElement('a');
    a.href = `/lightning/r/Contact/${created.id}/view`;
    a.textContent = name;
    const td1 = document.createElement('th');
    td1.scope = 'row';
    td1.appendChild(a);
    const td2 = document.createElement('td');
    td2.textContent = email;
    tr.append(td1, td2);
    tbody.appendChild(tr);
    count.textContent = String(Number(count.textContent) + 1);
    close();
    showToast(`Contact "${name}" was created.`, 'success');
  });
})();
