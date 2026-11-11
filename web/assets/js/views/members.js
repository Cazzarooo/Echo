import { avatar, h } from '../dom.js';
import { activeSpace, subscribe } from '../state.js';

const byName = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/** Painel da direita: quem está na roda, separado por presença. */
export function createMembers() {
  const element = h('aside', { class: 'members', 'aria-label': 'Quem está na roda' });

  function group(label, people) {
    if (people.length === 0) return null;
    return h(
      'section',
      { class: 'members__group' },
      h('h2', { class: 'section-head' }, `${label} · ${people.length}`),
      h(
        'ul',
        {},
        people.map((person) =>
          h(
            'li',
            { class: person.online ? 'member' : 'member is-offline' },
            h('span', { class: 'member__avatar' }, avatar(person, true), h('span', { class: 'member__presence' })),
            h('span', { class: 'member__name' }, person.displayName),
          ),
        ),
      ),
    );
  }

  function render() {
    const space = activeSpace();
    if (!space) {
      element.replaceChildren();
      return;
    }
    const people = [...space.members].sort((a, b) => byName.compare(a.displayName, b.displayName));
    element.replaceChildren(
      ...[group('Por aqui', people.filter((person) => person.online)), group('Ausentes', people.filter((person) => !person.online))].filter(Boolean),
    );
  }

  const unsubscribe = subscribe((topic) => {
    if (topic === 'members' || topic === 'spaces' || topic === 'active') render();
  });
  render();

  return { element, destroy: unsubscribe };
}
