function clamp(min, x, max) {
  return Math.max(min, Math.min(x, max));
}

module.exports = {
  clamp,
};
