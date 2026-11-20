// Fills [data-param] elements with the page's query parameters, as text only.
const params = new URLSearchParams(location.search);
for (const node of document.querySelectorAll('[data-param]')) {
  const value = params.get(node.getAttribute('data-param'));
  if (value) { node.textContent = value; node.hidden = false; }
}
