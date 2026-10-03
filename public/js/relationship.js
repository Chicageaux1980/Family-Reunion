import { app, api, esc, notice, fullName, personChip, personPicker } from './core.js';

export async function renderRelationship(params) {
  document.title = 'How are we related? · Family Reunion';
  const preset = {};
  for (const key of ['a', 'b']) {
    if (params.get(key)) {
      try {
        const p = await api(`/api/people/${params.get(key)}`);
        preset[key] = { id: p.id, name: fullName(p) };
      } catch {}
    }
  }
  app.innerHTML = `
    <h1>How are we related?</h1>
    <p class="lead">Choose two people to find their closest common ancestors and what that makes them to each other.</p>
    <form class="card stack" id="rel-form">
      <div class="grid"><div id="pick-a"></div><div id="pick-b"></div></div>
      <div class="actions"><button class="btn" type="submit">Find relationship</button></div>
    </form>
    <div id="rel-result" style="margin-top:20px" aria-live="polite"></div>`;

  const pickers = {
    a: personPicker(document.getElementById('pick-a'), { label: 'First person', initial: preset.a ? [preset.a] : [] }),
    b: personPicker(document.getElementById('pick-b'), { label: 'Second person', initial: preset.b ? [preset.b] : [] }),
  };

  const show = async () => {
    const out = document.getElementById('rel-result');
    const [a] = pickers.a.selected();
    const [b] = pickers.b.selected();
    if (!a || !b) {
      out.innerHTML = notice('error', 'Please choose two people from the suggestions.');
      return;
    }
    history.replaceState(null, '', `#/relationship?a=${a.id}&b=${b.id}`);
    const r = await api(`/api/relationship?a=${a.id}&b=${b.id}`);
    out.innerHTML = `<section class="card">
        <p class="result-big">${esc(r.description)}</p>
        ${
          r.commonAncestors.length
            ? `<p class="muted">Closest common ${r.commonAncestors.length === 1 ? 'ancestor' : 'ancestors'}:</p>
               <div class="chips">${r.commonAncestors.map(personChip).join('')}</div>
               <p class="muted">${esc(r.a.name)} is ${generationsText(r.generationsFromA)} below them;
                 ${esc(r.b.name)} is ${generationsText(r.generationsFromB)} below them.</p>`
            : r.related
              ? ''
              : '<p class="muted">Adding more parents and grandparents may connect these branches.</p>'
        }
        <div class="actions"><a class="btn secondary small" href="#/tree/${r.a.id}">View tree</a></div>
      </section>`;
  };
  document.getElementById('rel-form').addEventListener('submit', (event) => {
    event.preventDefault();
    show().catch((err) => (document.getElementById('rel-result').innerHTML = notice('error', err.message)));
  });
  if (preset.a && preset.b) await show();
}

function generationsText(n) {
  if (n === 0) return 'the ancestor';
  return `${n} generation${n === 1 ? '' : 's'}`;
}
