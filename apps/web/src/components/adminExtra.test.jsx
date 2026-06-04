import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { api } from '../lib/api.js';
import * as auth from '../lib/auth.js';
import { AdminPublish } from './adminExtra.jsx';

const renderPublishPage = () => render(
  <MemoryRouter initialEntries={["/admin/auctions/new"]}>
    <Routes>
      <Route path="/admin/auctions/new" element={<AdminPublish />} />
    </Routes>
  </MemoryRouter>,
);

describe('AdminPublish', () => {
  beforeEach(() => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(undefined);
    vi.spyOn(api, 'createProduct').mockResolvedValue({ productId: 'prod_spy' });
    vi.spyOn(api, 'createDraft').mockResolvedValue({ auctionId: 'auc_spy' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('sends auctionMode in createDraft payload', async () => {
    renderPublishPage();

    const settlementMode = screen.getByRole('combobox', { name: /结算方式/ });

    fireEvent.change(settlementMode, { target: { value: 'second_price' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步 · VLM 核对 →' }));

    await waitFor(() => {
      expect(auth.ensureSession).toHaveBeenCalledWith('seller-demo');
      expect(api.createProduct).toHaveBeenCalledTimes(1);
      expect(api.createDraft).toHaveBeenCalledTimes(1);
    });

    const call = api.createDraft.mock.calls[0];
    expect(call[0]).toEqual(
      expect.objectContaining({
        productId: 'prod_spy',
        rules: expect.objectContaining({
          auctionMode: 'second_price',
        }),
      }),
    );
  });

  it('defaults auctionMode to first_price', () => {
    renderPublishPage();

    const settlementMode = screen.getByRole('combobox', { name: /结算方式/ });

    expect(settlementMode).toHaveValue('first_price');
  });
});
