// script.js – dynamically load project table from markdown
// Fetches the markdown file from the repository’s raw URL and parses the table rows.

const MARKDOWN_URL = 'https://raw.githubusercontent.com/c4louT/pravoeb-workspace/main/memory/tema/projects/_index.md';

function parseTable(markdown) {
  const lines = markdown.split('\n');
  const rows = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith('|') && line.includes('|')) {
      // Skip header separator (---) line
      if (line.match(/^\|[-:|\s]+\|$/)) {
        inTable = true;
        continue;
      }
      if (inTable) {
        const cols = line.split('|').map(c => c.trim()).filter(c => c !== '');
        if (cols.length >= 6) {
          rows.push({slug: cols[0], name: cols[1], status: cols[2], start: cols[3], contracts: cols[4], file: cols[5]});
        }
      }
    }
  }
  return rows;
}

function renderRows(rows) {
  const tbody = document.querySelector('tbody');
  tbody.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.slug}</td>
      <td>${r.name}</td>
      <td>${r.status}</td>
      <td>${r.start}</td>
      <td>${r.contracts}</td>
      <td>${r.file}</td>
    `;
    tbody.appendChild(tr);
  });
}

fetch(MARKDOWN_URL)
  .then(resp => resp.text())
  .then(md => {
    const rows = parseTable(md);
    renderRows(rows);
  })
  .catch(err => {
    console.error('Failed to load project data', err);
    const tbody = document.querySelector('tbody');
    tbody.innerHTML = '<tr><td colspan="6">Ошибка загрузки данных</td></tr>';
  });
