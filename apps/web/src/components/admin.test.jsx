// src/components/admin.test.jsx
//
// Verifies AdminVLMFacts admin freeze gate and startLive handoff:
// - all 5 facts must be confirmed before the CTA becomes clickable
// - freeze payload includes confirmed facts payload when enabled
// - freeze backend failure -> visible error banner with error code (e.g. ERR_FACTS_NOT_CONFIRMED)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ApiError, api } from '../lib/api.js';
import * as auth from '../lib/auth.js';
import { AdminVLMFacts } from './admin.jsx';

const renderVLMPage = () => {
  return render(
    <MemoryRouter initialEntries={["/admin/auctions/auc_demo/vlm"]}>
      <Routes>
        <Route path="/admin/auctions/:id/vlm" element={<AdminVLMFacts />} />
      </Routes>
    </MemoryRouter>,
  );
};

describe('AdminVLMFacts · TC-T6-114', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(undefined);
    vi.spyOn(api, 'freeze').mockResolvedValue({ code: 'OK_FROZEN' });
    vi.spyOn(api, 'startLive').mockResolvedValue({ code: 'OK_LIVE' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the CTA disabled until all five facts are confirmed/edited', () => {
    renderVLMPage();

    const launchCta = screen.getByRole('button', { name: '全部确认后开拍' });
    expect(launchCta).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '采纳并补录' }));
    expect(launchCta).not.toBeDisabled();
  });

  it('sends factsConfirmed payload when CTA is enabled and clicked', async () => {
    renderVLMPage();

    fireEvent.click(screen.getByRole('button', { name: '采纳并补录' }));
    fireEvent.click(screen.getByRole('button', { name: '全部确认后开拍' }));

    await waitFor(() => {
      expect(auth.ensureSession).toHaveBeenCalledTimes(1);
      expect(api.freeze).toHaveBeenCalledTimes(1);
    });

    expect(api.freeze).toHaveBeenCalledWith(
      'auc_demo',
      expect.objectContaining({
        factsConfirmed: true,
        confirmedFacts: expect.objectContaining({
          version: 1,
          facts: expect.any(Array),
        }),
      }),
    );
    expect(api.freeze.mock.calls[0][1].confirmedFacts.facts).toHaveLength(5);
    expect(api.startLive).toHaveBeenCalledWith('auc_demo');
  });

  it('shows ERR_FACTS_NOT_CONFIRMED when freeze is rejected by backend', async () => {
    api.freeze.mockRejectedValueOnce(new ApiError(
      409,
      'ERR_FACTS_NOT_CONFIRMED',
      'all fact slots must be confirmed first',
    ));

    renderVLMPage();

    fireEvent.click(screen.getByRole('button', { name: '采纳并补录' }));
    fireEvent.click(screen.getByRole('button', { name: '全部确认后开拍' }));

    await waitFor(() => {
      expect(api.freeze).toHaveBeenCalledTimes(1);
    });

    expect(api.startLive).not.toHaveBeenCalled();
    expect(screen.getByText(/开拍失败 · ERR_FACTS_NOT_CONFIRMED/)).toBeInTheDocument();
    expect(screen.getByText(/all fact slots must be confirmed first/)).toBeInTheDocument();
  });

  it('edits a fact inline without window.prompt and submits the edited value', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('should-not-be-used');
    renderVLMPage();

    fireEvent.click(screen.getAllByRole('button', { name: '修改' })[0]);
    const editor = screen.getByRole('textbox', { name: '编辑品牌' });
    fireEvent.change(editor, { target: { value: 'Patek Philippe · seller-confirmed inline edit' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(promptSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '采纳并补录' }));
    fireEvent.click(screen.getByRole('button', { name: '全部确认后开拍' }));

    await waitFor(() => {
      expect(api.freeze).toHaveBeenCalledTimes(1);
    });

    const brandFact = api.freeze.mock.calls[0][1].confirmedFacts.facts.find((f) => f.field === 'brand');
    expect(brandFact).toEqual(expect.objectContaining({
      status: 'edited',
      value: 'Patek Philippe · seller-confirmed inline edit',
    }));
  });
});
