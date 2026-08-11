/**
 * @vitest-environment jsdom
 *
 * Exercise library — filtering, video fallback, and licence attribution.
 *
 * The attribution tests are not cosmetic: the imported rows are CC-BY-SA, so
 * showing a description without crediting the author and naming the licence
 * is a licence breach, not a missing label.
 */
import { describe, it, expect } from 'vitest';

const {
  filterExercises,
  facetsFor,
  videoLinkFor,
  renderAttribution,
  renderExerciseLibrary,
} = await import('../js/exercise-library.js');

const library = [
  {
    id: '1', name: 'Barbell Bench Press', category: 'Chest',
    primary_muscles: ['Chest'], secondary_muscles: ['Triceps', 'Shoulders'],
    equipment: ['Barbell'], description: 'Lie on the bench.',
    source: 'wger', license: 'CC-BY-SA 4', license_author: 'Anon',
    image_url: 'https://wger.de/img/bench.png', video_url: null,
  },
  {
    id: '2', name: 'Romanian Deadlift', category: 'Legs',
    primary_muscles: ['Hamstrings'], secondary_muscles: ['Glutes'],
    equipment: ['Barbell'], description: null,
    source: 'wger', license: 'CC0', license_author: null,
    image_url: null, video_url: 'https://wger.de/media/rdl.mp4',
  },
  {
    id: '3', name: 'Press-up', category: 'Chest',
    primary_muscles: ['Chest'], secondary_muscles: [],
    equipment: ['Bodyweight'], description: null,
    source: 'builtin', license: null, license_author: null,
    image_url: null, video_url: null,
  },
];

describe('filterExercises', () => {
  it('returns everything with no filters', () => {
    expect(filterExercises(library, {})).toHaveLength(3);
  });

  it('filters by body part', () => {
    const result = filterExercises(library, { category: 'Chest' });
    expect(result.map(e => e.name)).toEqual(['Barbell Bench Press', 'Press-up']);
  });

  it('filters by equipment', () => {
    const result = filterExercises(library, { equipment: 'Bodyweight' });
    expect(result.map(e => e.name)).toEqual(['Press-up']);
  });

  it('combines filters', () => {
    expect(filterExercises(library, { category: 'Chest', equipment: 'Barbell' }))
      .toHaveLength(1);
  });

  it('searches muscles, not just names', () => {
    // Searching "hamstrings" should find the lifts that train them, not only
    // the ones with the word in the title — which is none of them.
    const result = filterExercises(library, { search: 'hamstrings' });
    expect(result.map(e => e.name)).toEqual(['Romanian Deadlift']);
  });

  it('searches secondary muscles too', () => {
    const result = filterExercises(library, { search: 'triceps' });
    expect(result.map(e => e.name)).toEqual(['Barbell Bench Press']);
  });

  it('is case insensitive', () => {
    expect(filterExercises(library, { search: 'BENCH' })).toHaveLength(1);
  });

  it('survives an exercise with no muscles or equipment recorded', () => {
    const sparse = [{ id: '9', name: 'Mystery lift' }];
    expect(filterExercises(sparse, { search: 'mystery' })).toHaveLength(1);
    expect(filterExercises(sparse, { equipment: 'Barbell' })).toHaveLength(0);
  });
});

describe('facetsFor', () => {
  it('takes filter options from the data rather than a fixed list', () => {
    // The library is imported, so a hardcoded list would drift the moment the
    // seed is regenerated.
    const facets = facetsFor(library);
    expect(facets.equipment).toEqual(['Barbell', 'Bodyweight']);
    expect(facets.muscles).toContain('Hamstrings');
  });

  it('orders body parts by training importance, not alphabetically', () => {
    const facets = facetsFor(library);
    expect(facets.categories).toEqual(['Legs', 'Chest']);
  });
});

describe('videoLinkFor', () => {
  it('uses the hosted video when there is one', () => {
    const link = videoLinkFor(library[1]);
    expect(link.href).toBe('https://wger.de/media/rdl.mp4');
    expect(link.hosted).toBe(true);
  });

  it('falls back to a YouTube search, not a guessed video id', () => {
    // Only 45 of 722 exercises have a hosted video, so this is the common
    // path. A search always resolves; a fabricated id would 404.
    const link = videoLinkFor(library[0]);
    expect(link.hosted).toBe(false);
    expect(link.href).toContain('youtube.com/results?search_query=');
    expect(link.href).toContain('Barbell');
  });

  it('encodes the query safely', () => {
    const link = videoLinkFor({ name: 'Farmer\'s carry & walk' });
    expect(link.href).not.toMatch(/[ &]/);
  });
});

describe('renderAttribution', () => {
  it('credits the author and names the licence', () => {
    const html = renderAttribution(library[0]);
    expect(html).toContain('Anon');
    expect(html).toContain('CC-BY-SA 4');
    expect(html).toContain('wger.de');
  });

  it('still names the licence when no author is recorded', () => {
    expect(renderAttribution(library[1])).toContain('CC0');
  });

  it('says nothing for the original hand-written rows', () => {
    // They carry no third-party licence, so there is nothing to attribute.
    expect(renderAttribution(library[2])).toBe('');
  });
});

describe('renderExerciseLibrary', () => {
  it('renders filter controls and a count', () => {
    const mount = document.createElement('div');
    renderExerciseLibrary(mount, library);

    expect(mount.querySelector('#exercise-category')).not.toBeNull();
    expect(mount.querySelector('#exercise-equipment')).not.toBeNull();
    expect(mount.textContent).toMatch(/3 exercises/);
  });

  it('does not fetch images until a card is opened', () => {
    // 722 cards rendering their image up front would pull every one of them
    // over a phone connection to show a list you scroll straight past.
    const mount = document.createElement('div');
    renderExerciseLibrary(mount, library);
    expect(mount.querySelector('img')).toBeNull();
  });

  it('tells the user when the database is empty rather than looking broken', () => {
    const mount = document.createElement('div');
    renderExerciseLibrary(mount, []);
    expect(mount.textContent).toMatch(/migrations/i);
  });

  it('narrows the list when a filter changes', () => {
    const mount = document.createElement('div');
    renderExerciseLibrary(mount, library);

    const select = mount.querySelector('#exercise-category');
    select.value = 'Chest';
    select.dispatchEvent(new Event('change'));

    expect(mount.querySelectorAll('.exercise-card')).toHaveLength(2);
  });
});
