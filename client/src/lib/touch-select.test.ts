import { touchToCell, selectionLength } from './touch-select';

describe('touchToCell', () => {
  const rect = { left: 0, top: 0, width: 800, height: 400 };

  it('maps a point to the correct col/row', () => {
    expect(touchToCell(0, 0, rect, 80, 24)).toEqual({ col: 0, row: 0 });
    expect(touchToCell(799, 399, rect, 80, 24)).toEqual({ col: 79, row: 23 });
    expect(touchToCell(400, 200, rect, 80, 24)).toEqual({ col: 40, row: 12 });
  });

  it('clamps points outside the rect', () => {
    expect(touchToCell(-50, -50, rect, 80, 24)).toEqual({ col: 0, row: 0 });
    expect(touchToCell(5000, 5000, rect, 80, 24)).toEqual({ col: 79, row: 23 });
  });
});

describe('selectionLength', () => {
  it('spans within a single row', () => {
    expect(selectionLength(5, 2, 10, 2, 80)).toBe(6);
    expect(selectionLength(10, 2, 5, 2, 80)).toBe(6); // drag backwards
  });

  it('spans across multiple rows', () => {
    // row 2 col 70 -> row 4 col 5, cols=80: (4-2)*80 + (5-70) + 1 = 160-65+1=96
    expect(selectionLength(70, 2, 5, 4, 80)).toBe(96);
    expect(selectionLength(5, 4, 70, 2, 80)).toBe(96); // reversed drag
  });

  it('never returns less than 1', () => {
    expect(selectionLength(5, 2, 5, 2, 80)).toBe(1);
  });
});
