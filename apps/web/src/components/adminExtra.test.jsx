// src/components/adminExtra.test.jsx
//
// ImageDropZone — 拖拽/点击上传商品图 (spec: 竞拍发布 上传商品).
// Drag-drop → POST /api/upload → onChange("/uploads/<name>"); client-side
// type/size validation never hits the network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { api } from '../lib/api.js';
import * as auth from '../lib/auth.js';
import { ImageDropZone } from './adminExtra.jsx';

const makeFile = (name, type, sizeBytes) => {
  const f = new File(['x'], name, { type });
  // jsdom File size mirrors content length; force the size we need.
  Object.defineProperty(f, 'size', { value: sizeBytes });
  return f;
};

describe('ImageDropZone', () => {
  beforeEach(() => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(undefined);
    vi.spyOn(api, 'uploadImage').mockResolvedValue({ url: '/uploads/123-abcd.png' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads a dropped image and reports the same-origin URL', async () => {
    const onChange = vi.fn();
    render(<ImageDropZone imageUrl="" onChange={onChange}/>);

    const zone = screen.getByTestId('image-dropzone');
    const file = makeFile('watch.png', 'image/png', 1024);
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/uploads/123-abcd.png'));
    expect(api.uploadImage).toHaveBeenCalledWith(file);
  });

  it('rejects a non-image file client-side without calling the API', async () => {
    const onChange = vi.fn();
    render(<ImageDropZone imageUrl="" onChange={onChange}/>);

    fireEvent.drop(screen.getByTestId('image-dropzone'), {
      dataTransfer: { files: [makeFile('evil.exe', 'application/octet-stream', 1024)] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/仅支持/);
    expect(api.uploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects an oversized image client-side', async () => {
    const onChange = vi.fn();
    render(<ImageDropZone imageUrl="" onChange={onChange}/>);

    fireEvent.drop(screen.getByTestId('image-dropzone'), {
      dataTransfer: { files: [makeFile('huge.png', 'image/png', 6 * 1024 * 1024)] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/5MB/);
    expect(api.uploadImage).not.toHaveBeenCalled();
  });

  it('surfaces an upload failure with a retry-friendly message', async () => {
    vi.spyOn(api, 'uploadImage').mockRejectedValue(new Error('网络中断'));
    const onChange = vi.fn();
    render(<ImageDropZone imageUrl="" onChange={onChange}/>);

    fireEvent.drop(screen.getByTestId('image-dropzone'), {
      dataTransfer: { files: [makeFile('watch.png', 'image/png', 1024)] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/上传失败/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the URL paste path available as a fallback', () => {
    const onChange = vi.fn();
    render(<ImageDropZone imageUrl="" onChange={onChange}/>);

    fireEvent.click(screen.getByText('或粘贴图片 URL'));
    const input = screen.getByPlaceholderText('https://…/item.jpg');
    fireEvent.change(input, { target: { value: 'https://cdn.example.com/a.jpg' } });
    expect(onChange).toHaveBeenCalledWith('https://cdn.example.com/a.jpg');
  });
});
