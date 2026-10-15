module.exports = {
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: null })),
};
