// sorts the array of images by creation date
// the most recent AMIs will appear first

/**
 * sorts the array of images by creation date
 * the most recent AMIs will appear first
 *
 * @param data
 */
function sortByCreationDate(data) {
  const images = data.Images;
  images.sort(function(a,b) {
    const dateA = new Date(a['CreationDate']).getTime();
    const dateB = new Date(b['CreationDate']).getTime();

    return dateB - dateA;
  });
}

// Parse a comma-separated input into a trimmed, non-empty list. A single
// value yields a one-element list, so callers behave identically whether the
// user passed "subnet-a" or "subnet-a,subnet-b". Empty/whitespace entries
// (e.g. trailing commas) are dropped.
function parseCsv(value) {
  if (!value) {
    return [];
  }
  return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

// Infer whether an EC2 instance type is arm64/Graviton from its name. AWS
// Graviton families carry a 'g' as the processor letter after the
// generation digit (c7g, m6gd, t4g, x2gd, im4gn, is4gen, hpc7g, g5g), plus
// the first-gen a1. Everything else is treated as x64. Name-based heuristic
// (no API call) — used only to reject obviously mixed-arch fallback lists.
function isArmInstanceType(instanceType) {
  const family = String(instanceType).split('.')[0];
  return /\dg[a-z]*$/.test(family) || family === 'a1';
}

// The architecture ('x64' | 'arm64') implied by an instance type name.
function instanceArch(instanceType) {
  return isArmInstanceType(instanceType) ? 'arm64' : 'x64';
}

module.exports = {
  sortByCreationDate,
  parseCsv,
  isArmInstanceType,
  instanceArch,
}
