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

module.exports = {
  sortByCreationDate,
  parseCsv,
}
