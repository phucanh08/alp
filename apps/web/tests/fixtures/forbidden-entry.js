// A browser entry that reaches the Node client through an innocent-looking helper: the boundary
// gate must fail the build on the transitive import.
import { helper } from './forbidden-helper.js';
document.body.textContent = String(helper);
