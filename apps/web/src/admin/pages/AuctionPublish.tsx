import { useCallback, useEffect, useRef, useState } from 'react';
import { Form, Input, InputNumber, Select, Switch, Button, Upload, Divider, Space, Alert, Popconfirm, Tag, Checkbox, App as AntdApp } from 'antd';
import { PlusOutlined, RocketOutlined, SaveOutlined, ThunderboltOutlined, FolderOpenOutlined, DeleteOutlined, HistoryOutlined, VideoCameraAddOutlined, CheckCircleFilled, LoadingOutlined } from '@ant-design/icons';
import { fmtMoney } from '../../lib/format';
import { recommendIncrement } from '../../lib/pricing';
import { PROD } from '../../lib/assets';
import { INTRO_TEMPLATES, defaultIntro, pickIntro, pickEstimate } from '../../lib/intro';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';
import { isJunk, isDeletableAuction } from '../../lib/mapBackend';
import { listDrafts, upsertDraft, removeDraft, newDraftId, fmtSavedAt, type AuctionDraft } from '../drafts';

const yuanToCents = (y: unknown): string => String(Math.round((Number(y) || 0) * 100));

// Local placeholder images (products/...) and uploaded images (/uploads/...) are both
// relative paths; the imageUrl sent to AI vision and stored in the backend is always
// promoted to a same-origin absolute URL (passes SSRF checks, reachable cross-client).
const toAbsUrl = (u: string): string => (u.startsWith('http') ? u : new URL(u, location.href).toString());

const CAT_EMOJI: Record<string, string> = { Watches: '⌚️', Bags: '👜', Apparel: '👗', Shoes: '👟' };
const CAT_IMG: Record<string, string> = { Watches: PROD.watch, Bags: PROD.bag, Apparel: PROD.apparel, Shoes: PROD.shoes };

export default function AuctionPublish() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [sellingPoints, setSellingPoints] = useState<string[]>([]);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const v = Form.useWatch([], form) || {};
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [fileList, setFileList] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<AuctionDraft[]>(() => listDrafts());
  const [draftId, setDraftId] = useState<string | null>(null); // the draft currently loaded into the form; consumed once publishing succeeds
  const [aiBusy, setAiBusy] = useState(false); // #261-12b AI image recognition in progress
  const [aiEstimate, setAiEstimate] = useState<number | null>(null); // #261-12b image-based estimate (yuan) -> suggested bid increment
  const [videoFile, setVideoFile] = useState<File | null>(null); // #261-12b live video: the selected local file (for showing name/size)
  const [videoUrl, setVideoUrl] = useState<string | null>(null); // the /uploads/<name> the server returns after the drop-to-upload
  const [videoUploading, setVideoUploading] = useState(false); // a drop-triggered upload is in flight
  const videoUploadRef = useRef<Promise<string | null> | null>(null); // in-flight upload: if the user is quick and it has not finished at publish time, await it
  const videoSeqRef = useRef(0); // upload token: invalidates the write-back of a stale upload on re-drop/remove, avoiding races
  const [history, setHistory] = useState<any[]>([]); // #261-13 publish history
  const previewImg = uploadedUrl || (CAT_IMG[v.category as string] ?? PROD.watch);
  const step = v.step ?? 50;

  // #261-13: publish history - the host can see what this stream has published (10s polling, same source as product management).
  const loadHistory = useCallback(async () => {
    try {
      const { auctions = [] } = await api.listAuctions({ limit: 500 } as any);
      setHistory((auctions as any[]).filter((a) => a.auctionId && !isJunk(a.productName)).slice(0, 10));
    } catch { /* keep last good */ }
  }, []);
  useEffect(() => {
    loadHistory();
    const t = setInterval(loadHistory, 10_000);
    return () => clearInterval(t);
  }, [loadHistory]);

  // Publish-history management (multi-select / select-all delete) - only finished lots can be
  // deleted (sold / no bid / withdrawn); LIVE and upcoming DRAFT/SCHEDULED lots cannot be deleted
  // and must be withdrawn first. Delete goes through a backend hard delete that also removes the
  // resulting order and bid events, and is not recoverable.
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const deletableIds = history.filter((a) => isDeletableAuction(a.status)).map((a) => a.auctionId as string);
  const selectedCount = deletableIds.filter((id) => selected.has(id)).length;
  const allSelected = deletableIds.length > 0 && selectedCount === deletableIds.length;
  const toggleSelect = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(deletableIds));
  const exitManage = () => { setManage(false); setSelected(new Set()); };
  const onDeleteSelected = async () => {
    const ids = deletableIds.filter((id) => selected.has(id));
    if (ids.length === 0) { message.warning('Select the publish records to delete'); return; }
    setDeleting(true);
    try {
      await ensureSession('seller-demo');
      const results = await Promise.allSettled(ids.map((id) => api.deleteAuction(id)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      if (ok > 0) message.success(`Permanently deleted ${ok} publish record(s)${fail ? `, ${fail} failed` : ''}`);
      else message.error('Delete failed: ' + ((results[0] as PromiseRejectedResult | undefined)?.reason?.message || 'please retry'));
      setSelected(new Set());
      await loadHistory();
    } catch (e: any) {
      message.error('Delete failed: ' + (e?.message || e));
    } finally {
      setDeleting(false);
    }
  };

  // #256: AI auction copy (title / selling points / opening line, drafted by the LLM) - coexists
  // with the #261 vision-based intro: the vision button owns the product description (written from
  // the photo), while this button owns title + selling points + script (read from the form text).
  const onGenerateCopy = async () => {
    if (copyBusy) return;
    const vals = form.getFieldsValue();
    setCopyBusy(true);
    setCopyNote(null);
    try {
      await ensureSession('seller-demo');
      const draft = await api.draftListing({
        title: vals.name || '',
        description: vals.intro || '',
        category: vals.category || '',
      });
      const next: Record<string, string> = {};
      if (draft?.title) next.name = draft.title;
      if (draft?.script) next.intro = draft.script;
      if (Object.keys(next).length > 0) form.setFieldsValue(next);
      setSellingPoints(Array.isArray(draft?.sellingPoints) ? draft.sellingPoints : []);
      const note = draft?.fallback
        ? 'AI unavailable - fallback copy filled in, you can keep editing'
        : 'AI draft ready - review it before publishing';
      setCopyNote(note);
      message.success(note);
    } catch (e: any) {
      const msg = 'Generation failed: ' + (e?.message || e);
      setCopyNote(msg);
      message.warning(msg);
    } finally {
      setCopyBusy(false);
    }
  };

  // REAL upload: POST /api/upload (multipart) → { url } same-origin; stored as the product imageUrl.
  const handleUpload = async (file: File): Promise<boolean> => {
    if (!/image\/(png|jpe?g|webp|gif)/.test(file.type)) { message.error('Only png / jpg / webp / gif are supported'); return false; }
    if (file.size > 5 * 1024 * 1024) { message.error('The image must be 5MB or smaller'); return false; }
    setFileList([{ uid: file.name, name: file.name, status: 'uploading' }]);
    try {
      await ensureSession('seller-demo');
      const { url } = await api.uploadImage(file);
      setUploadedUrl(url);
      setFileList([{ uid: file.name, name: file.name, status: 'done', url }]);
      message.success('Product cover image uploaded');
    } catch (e: any) {
      setFileList([]); setUploadedUrl(null);
      message.error('Image upload failed: ' + (e?.message || e));
    }
    return false; // stop antd's built-in XHR; we upload via api.uploadImage
  };

  // AI-generated product description (#261-12b) - real image recognition first, no template-first:
  //   clicking calls the real Doubao multimodal vision endpoint (/facts/draft) and writes a human,
  //   sales-ready description straight from the uploaded cover image (the sidecar already applies
  //   compliance cleanup plus the disclaimer tail). The spinner runs for at most 15s; only when
  //   recognition fails or times out do we fall back to the category template (the demo must never
  //   be blank), and we say so explicitly.
  const onAiIntro = () => {
    const name = String(form.getFieldValue('name') || '').trim();
    if (!name) { message.warning('Enter the product name first'); return; }
    if (!uploadedUrl) { message.warning('Upload the cover image first - the AI writes from the real photo'); return; }
    const category = form.getFieldValue('category') as string;
    setAiBusy(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    void (async () => {
      try {
        await ensureSession('seller-demo');
        const resp = await api.draftFacts({
          productId: 'draft-preview',
          title: name,
          description: String(form.getFieldValue('intro') || ''),
          // AI vision needs an ABSOLUTE URL the server can fetch.
          imageUrls: [toAbsUrl(uploadedUrl)],
          signal: ctrl.signal,
        });
        const refined = pickIntro(name, resp);
        // The vision estimate comes back with it (used by the AI-suggested increment - #261-12b).
        const est = pickEstimate(resp);
        if (est) setAiEstimate(est);
        if (refined) {
          form.setFieldsValue({ intro: refined });
          message.success(est ? `AI wrote the description from your photo - estimated around ¥${fmtMoney(est)}` : 'AI wrote the description from your photo');
          return;
        }
        throw new Error('empty intro');
      } catch {
        // Recognition failed or timed out -> template fallback (say so, do not pass it off as AI).
        const tpl = (INTRO_TEMPLATES[category] ?? defaultIntro)(name).slice(0, 200);
        form.setFieldsValue({ intro: tpl });
        message.warning('AI vision is unavailable, generic copy used for now - tap to retry');
      } finally {
        clearTimeout(timer);
        setAiBusy(false);
      }
    })();
  };

  // AI-suggested bid increment (#261-12b, vision-driven): prefer the AI vision estimate
  // (estimateCNY, returned automatically once the vision description has been generated) and take
  // a round ~2.5% step; without an estimate, fall back to the cap-price heuristic.
  // See lib/pricing.recommendIncrement.
  const onAiStep = () => {
    const cap = Number(form.getFieldValue('cap')) || 0;
    const basis = aiEstimate ?? cap;
    if (!basis) { message.warning('Tap "AI description from photo" to get an estimate first, or fill in the cap price'); return; }
    const rec = recommendIncrement(basis);
    form.setFieldsValue({ step: rec }); // the minStep field was removed per #255 (aligned with the backend model.Rules)
    message.success(aiEstimate
      ? `AI estimated ¥${fmtMoney(aiEstimate)} from the photo -> suggested increment ¥${rec}`
      : `AI suggested increment ¥${rec} (about 2.5% of the cap price)`);
  };

  // ---- Draft box: persisted in localStorage (a single seller on one machine is enough for the demo).
  // Save / load / delete, and a draft is consumed once publishing succeeds. ----
  const onSaveDraft = () => {
    const vals = form.getFieldsValue();
    const name = String(vals.name || '').trim();
    if (!name) { message.warning('Fill in the product name before saving a draft'); return; }
    const id = draftId ?? newDraftId();
    setDrafts(upsertDraft({
      id, savedAt: Date.now(), name,
      category: vals.category, intro: vals.intro,
      cap: vals.cap, step: vals.step,
      duration: vals.duration, autoExtend: vals.autoExtend, extendSec: vals.extendSec,
      imageUrl: uploadedUrl,
    }));
    setDraftId(id);
    message.success(draftId ? 'Draft updated - see the draft box below' : 'Saved to the draft box below 📦');
  };

  const onLoadDraft = (d: AuctionDraft) => {
    form.setFieldsValue({
      name: d.name, category: d.category, intro: d.intro,
      cap: d.cap, step: d.step,
      duration: d.duration, autoExtend: d.autoExtend, extendSec: d.extendSec,
    });
    if (d.imageUrl) {
      setUploadedUrl(d.imageUrl);
      setFileList([{ uid: d.id, name: 'draft cover image', status: 'done', url: d.imageUrl }]);
    } else {
      setUploadedUrl(null);
      setFileList([]);
    }
    setDraftId(d.id);
    message.success(`Loaded the draft "${d.name}" - keep editing and publish`);
  };

  const onDeleteDraft = (id: string) => {
    setDrafts(removeDraft(id));
    if (draftId === id) setDraftId(null);
    message.success('Draft deleted');
  };

  // #261-12b drop to upload: as soon as the video lands in the box, the 64MB file goes to the
  // generic /api/upload/video (no auctionId needed), so the upload overlaps with the time still
  // spent filling in the form rather than starting only when publish is tapped.
  // The resulting /uploads/<name> is kept in videoUrl and shipped with createDraft's
  // rules.livePlayUrl at publish time (the video is in place at second zero of the auction), so
  // "publish now" is instant and never waits on the upload.
  // A seq token guards it: on re-drop or mid-flight removal, a late write-back from the old upload
  // is invalidated by token and cannot pollute state.
  const startVideoUpload = (file: File) => {
    const seq = ++videoSeqRef.current;
    setVideoUploading(true);
    setVideoUrl(null);
    const mb = Math.round((file.size / 1024 / 1024) * 10) / 10;
    const hide = message.loading(`Uploading live video (${mb}MB)...`, 0);
    const p = (async (): Promise<string | null> => {
      try {
        await ensureSession('seller-demo');
        const { url } = await api.uploadVideo(file);
        hide();
        if (videoSeqRef.current === seq) {
          setVideoUrl(url);
          message.success('🎬 Live video uploaded - it plays automatically when the auction starts');
        }
        return url;
      } catch (e: any) {
        hide();
        if (videoSeqRef.current === seq) {
          setVideoUrl(null);
          message.error('Video upload failed (tap retry, or it is re-sent automatically at publish): ' + (e?.message || String(e ?? 'unknown error')));
        }
        return null;
      } finally {
        if (videoSeqRef.current === seq) setVideoUploading(false);
      }
    })();
    videoUploadRef.current = p;
  };

  // Drag in a live video (mp4/webm, 64MB max) -> start uploading immediately (see startVideoUpload).
  const onPickVideo = (file: File): boolean => {
    if (!/^video\/(mp4|webm)$/.test(file.type)) { message.error('Only mp4 / webm are supported'); return false; }
    if (file.size > 64 * 1024 * 1024) { message.error('The video must be 64MB or smaller - please compress it first'); return false; }
    setVideoFile(file);
    startVideoUpload(file);
    return false; // do not use antd's built-in upload; we handle it ourselves
  };

  const removeVideo = () => {
    videoSeqRef.current++; // invalidate the write-back of any in-flight upload
    setVideoFile(null);
    setVideoUrl(null);
    setVideoUploading(false);
    videoUploadRef.current = null;
  };

  // REAL publish: createProduct → createDraft(rules) → freeze → start → LIVE.
  // The auction immediately appears in the buyer mobile rail and is biddable.
  const onPublish = () => {
    form.validateFields().then(async (vals: any) => {
      // #261-11: the auction runs on the image/video the seller actually uploaded - no silent fallback to a bundled sample.
      if (!uploadedUrl) { message.warning('Upload the cover image first (both the AI description and the buyer side use it)'); return; }
      setBusy(true);
      try {
        await ensureSession('seller-demo');
        const imageUrl = toAbsUrl(uploadedUrl);
        // Live video: prefer the URL from the drop-to-upload; if the user was quick and the upload is
        // still in flight, await it rather than uploading again. On outright failure liveUrl stays
        // null and the post-create fallback upload below handles it.
        let liveUrl = videoUrl;
        if (videoFile && !liveUrl && videoUploadRef.current) {
          try { liveUrl = await videoUploadRef.current; } catch { liveUrl = null; }
        }
        const { productId } = await api.createProduct({
          name: vals.name,
          imageUrl,
          description: vals.intro || '',
        });
        const durationSec = Number(vals.duration) || 80;
        const { auctionId } = await api.createDraft({
          productId,
          // factsConfirmed: the seller signs off the product facts entered here.
          // The backend freeze gate refuses to start until facts are confirmed.
          factsConfirmed: true,
          confirmedFacts: { description: vals.intro || '', category: vals.category || '' },
          rules: {
            mode: 'ENGLISH',
            // Always start from zero with no reserve: ignore the form value and hard-code 0.
            startPriceCents: '0',
            incrementCents: yuanToCents(vals.step),
            capPriceCents: yuanToCents(vals.cap),
            durationSec,
            extendWindowSec: 10,
            extendSec: vals.autoExtend === false ? 0 : (Number(vals.extendSec) || 30),
            maxExtensions: 10,
            // #261-12b drop-to-upload: ship the already-uploaded video URL with the auction creation so it is in place at second zero.
            ...(liveUrl ? { livePlayUrl: liveUrl } : {}),
          },
        });
        // #261-12b the live video is in place BEFORE the auction starts. The normal path already
        // persisted /uploads/<name> through rules.livePlayUrl above, so the video exists at second
        // zero and every buyer entering the room gets it. Only when the drop-upload failed or did
        // not finish in time (liveUrl empty but a file was chosen) do we re-send once before
        // freeze/start so the room is never empty; a failed re-send does not block publishing.
        if (videoFile && !liveUrl) {
          const mb = Math.round((videoFile.size / 1024 / 1024) * 10) / 10;
          const hideUp = message.loading(`Uploading live video (${mb}MB) - the auction starts when it finishes...`, 0);
          try {
            await api.uploadStreamVideo(auctionId, videoFile);
            hideUp();
            message.success('🎬 Live video is in place - it plays automatically when the auction starts');
          } catch (ve: any) {
            hideUp();
            message.warning('Video upload failed (you can re-upload from Live products - Start streaming): ' + (ve?.message || String(ve ?? 'unknown error')));
          }
        }
        await api.freeze(auctionId, { factsConfirmed: true });
        // #261-12a: the demoCrowd switch ships with the publish - the server's built-in crowd script
        // (~9997 viewers plus rule-driven simulated bids) is injected automatically when the auction starts.
        await api.startLive(auctionId, { durationMs: durationSec * 1000, demoCrowd: vals.demoCrowd !== false });
        message.success(`Published and live 🎉 now listed on mobile - ${auctionId.slice(0, 14)}`);
        // Reset the form and the uploaded cover after publishing: otherwise uploadedUrl carries over to
        // the next product and the listing shows the previous product's photo.
        form.resetFields();
        setUploadedUrl(null);
        setFileList([]);
        removeVideo(); // clear the video file / uploaded URL / in-flight upload so the next listing does not inherit them
        setAiEstimate(null);
        loadHistory(); // this listing shows up in the publish history immediately (#261-13)
        // A product loaded from a draft consumes that draft on a successful publish, so an already-listed product cannot be published twice from the draft box.
        if (draftId) { setDrafts(removeDraft(draftId)); setDraftId(null); }
      } catch (e: any) {
        message.error('Publish failed: ' + (e?.message || e));
      } finally {
        setBusy(false);
      }
    }).catch(() => message.error('Please complete the required fields and rule configuration'));
  };

  return (
    <div className="admin-content">
      <Alert type="info" showIcon style={{ marginBottom: 18 }} message="Publishing creates the auction state machine: listed -> bidding -> closing -> sold/no bid. Rules can no longer be changed once someone has bid, so configure them up front." />
      <div className="pub-grid">
        {/* #261-13: publish history - what this stream has published, at a glance. */}
        <div className="pub-history">
          <div className="pub-history-head">
            <HistoryOutlined /> Publish history
            <span className="pub-history-count">{history.length}</span>
            {history.length > 0 && (manage ? (
              <Button type="link" size="small" style={{ marginLeft: 'auto', padding: 0, height: 'auto' }} onClick={exitManage}>Done</Button>
            ) : (
              <Button type="link" size="small" style={{ marginLeft: 'auto', padding: 0, height: 'auto' }} icon={<DeleteOutlined />} onClick={() => setManage(true)}>Manage</Button>
            ))}
          </div>
          {manage && (
            <div className="pub-hist-toolbar">
              <Checkbox checked={allSelected} indeterminate={!allSelected && selectedCount > 0} disabled={deletableIds.length === 0} onChange={toggleSelectAll}>Select all deletable</Checkbox>
              <span className="pub-hist-toolbar-spacer" />
              <Popconfirm
                title={`Permanently delete the ${selectedCount} selected publish record(s)?`}
                description="This deletes them from the backend for good (including the resulting order and bid records) and cannot be undone"
                okText="Delete permanently"
                cancelText="Cancel"
                okButtonProps={{ danger: true }}
                onConfirm={onDeleteSelected}
                disabled={selectedCount === 0}
              >
                <Button danger size="small" icon={<DeleteOutlined />} loading={deleting} disabled={selectedCount === 0}>
                  Delete{selectedCount > 0 ? ` (${selectedCount})` : ''}
                </Button>
              </Popconfirm>
            </div>
          )}
          {history.length === 0 && <div className="pub-history-empty">No publish records yet.<br />Fill in the product on the right and publish in one tap.</div>}
          {history.map((a) => {
            const live = a.status === 'LIVE';
            const deletable = isDeletableAuction(a.status);
            const checked = selected.has(a.auctionId);
            const sub = a.status === 'LIVE' ? `Bidding - now ¥${fmtMoney(Math.round(Number(a.currentPriceCents || 0) / 100))}`
              : a.status === 'SOLD' || a.status === 'ORDER_CREATED' ? `Sold ¥${fmtMoney(Math.round(Number(a.currentPriceCents || 0) / 100))}`
              : a.status === 'CANCELLED' ? 'Withdrawn' : a.status === 'NO_BID' ? 'No bid' : 'Upcoming';
            return (
              <div key={a.auctionId} className={'pub-hist-item' + (live ? ' live' : '') + (manage && deletable && checked ? ' selected' : '')}>
                {manage && (
                  <span className="pub-hist-check" title={deletable ? '' : (live ? 'Live right now, cannot be deleted' : 'Not finished - withdraw it before deleting')} style={{ display: 'inline-flex' }}>
                    <Checkbox checked={checked} disabled={!deletable} onChange={() => toggleSelect(a.auctionId)} />
                  </span>
                )}
                <img className="pub-hist-thumb" src={a.imageUrl || PROD.watch} alt="" loading="lazy" />
                <div className="pub-hist-meta">
                  <div className="pub-hist-name">{a.productName || 'Live lot'}</div>
                  <div className="pub-hist-sub">{sub}{a.createdAtMs ? ` · ${new Date(a.createdAtMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
                </div>
                {live && <Tag color="#fe2c55" style={{ marginInlineEnd: 0 }}>LIVE</Tag>}
              </div>
            );
          })}
        </div>
        <Form form={form} layout="vertical" initialValues={{ category: 'Watches', start: 0, step: 50, cap: 12000, duration: 80, autoExtend: true, extendSec: 15, demoCrowd: true }}>
          <Divider orientation="left" plain>Product details</Divider>
          <Form.Item label="Cover image" required tooltip="Upload a real product photo (5MB max, png/jpg/webp) - the AI description is generated from this photo and buyers see it too">
            <Upload
              listType="picture-card"
              accept="image/png,image/jpeg,image/webp,image/gif"
              fileList={fileList}
              maxCount={1}
              beforeUpload={handleUpload}
              onRemove={() => { setFileList([]); setUploadedUrl(null); }}
            >
              {fileList.length >= 1 ? null : <div><PlusOutlined /><div style={{ marginTop: 6 }}>Upload</div></div>}
            </Upload>
          </Form.Item>
          {/* #261-12b: drop a video -> upload immediately (without waiting for publish) -> ship it with rules.livePlayUrl at publish time so it plays automatically when the auction starts, no OBS needed. */}
          <Form.Item label="Live video (optional)" tooltip="Drop in an mp4/webm (64MB max) and it starts uploading right away, no need to wait for publish. Once the auction starts it becomes this session's live feed and plays automatically when a buyer enters the room">
            <div className="pub-video-dragger">
              <Upload.Dragger accept="video/mp4,video/webm" showUploadList={false} beforeUpload={onPickVideo} maxCount={1}>
                <p style={{ margin: '6px 0 2px' }}><VideoCameraAddOutlined style={{ fontSize: 26, color: '#fe2c55' }} /></p>
                <p style={{ fontWeight: 600, margin: 0 }}>Drag a video here - it uploads on drop and plays when the auction starts</p>
                <p style={{ color: '#999', fontSize: 12, margin: '4px 0 6px' }}>H.264 mp4 recommended, 64MB max (webm does not play on iPhone; you can also push a real camera with OBS after publishing)</p>
              </Upload.Dragger>
            </div>
            {videoFile && (
              <div className="pub-video-meta">
                {videoUploading ? (
                  <span><LoadingOutlined /> Uploading: {videoFile.name} ({Math.round(videoFile.size / 1024 / 1024 * 10) / 10}MB)</span>
                ) : videoUrl ? (
                  <span><CheckCircleFilled /> Uploaded: {videoFile.name} ({Math.round(videoFile.size / 1024 / 1024 * 10) / 10}MB) - plays when the auction starts</span>
                ) : (
                  <span style={{ color: '#d4380d' }}>
                    Upload incomplete: {videoFile.name}
                    <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => startVideoUpload(videoFile)}>Retry upload</Button>
                  </span>
                )}
                {!videoUploading && (
                  <Button size="small" type="text" danger onClick={removeVideo}>Remove</Button>
                )}
              </div>
            )}
          </Form.Item>
          <Form.Item label="Product name" name="name" rules={[{ required: true, message: 'Enter the product name' }]}>
            <Input placeholder="e.g. Patek Philippe Annual Calendar Chronograph, rose gold blue dial" maxLength={60} showCount />
          </Form.Item>
          <Form.Item label="Category" name="category">
            <Select options={Object.keys(CAT_EMOJI).map((c) => ({ label: `${CAT_EMOJI[c]} ${c}`, value: c }))} />
          </Form.Item>
          <Form.Item
            name="intro"
            label={
              <Space>
                <span>Description</span>
                <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} loading={aiBusy} onClick={onAiIntro}>{aiBusy ? 'AI is reading the photo...' : '✨ AI description from photo'}</Button>
                <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} icon={<ThunderboltOutlined />} loading={copyBusy} onClick={onGenerateCopy}>AI auction copy</Button>
              </Space>
            }
          >
            <Input.TextArea rows={2} placeholder="Material, condition, certificate, flaws, and so on" maxLength={200} showCount />
          </Form.Item>
          {copyNote && (
            <div style={{ marginTop: -8, marginBottom: 10, fontSize: 12, color: '#8c8c8c' }}>{copyNote}</div>
          )}
          {sellingPoints.length > 0 && (
            <div style={{ marginTop: -2, marginBottom: 10 }}>
              <Space size={[6, 6]} wrap>
                {sellingPoints.map((p, i) => <Tag color="gold" key={`${p}-${i}`}>{p}</Tag>)}
              </Space>
            </div>
          )}
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="AI copy is a draft only"
            description="The title, selling points, and opening line are never published as authoritative facts; the seller must review them before publishing."
          />
          <Divider orientation="left" plain>Auction rules</Divider>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="Start price" name="start" style={{ flex: 1 }} extra="Starts at zero (fixed, no reserve)" tooltip="This auction always starts at zero with no reserve, so anyone can take part">
              <InputNumber min={0} max={0} step={0} value={0} disabled addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="Cap price" name="cap" style={{ flex: 1 }} tooltip="A bid that reaches the cap price closes the auction immediately">
              <InputNumber min={0} step={500} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item
              name="step"
              style={{ flex: 1 }}
              rules={[{ required: true }]}
              label={
                <Space>
                  <span>Bid increment (fixed)</span>
                  <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={onAiStep}>AI suggest</Button>
                </Space>
              }
            >
              <InputNumber min={1} step={10} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="Duration (seconds)" name="duration" style={{ flex: 1 }}>
              <InputNumber min={10} step={10} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex', alignItems: 'flex-start' }}>
            <Form.Item label="Auto-extend before the end" name="extendSec" style={{ flex: 1 }} tooltip="A bid within the last 10s extends the auction, by 10-30s">
              <InputNumber min={10} max={30} step={5} addonAfter="s" style={{ width: '100%' }} disabled={v.autoExtend === false} />
            </Form.Item>
            <Form.Item label="Enable extensions" name="autoExtend" valuePropName="checked">
              <Switch />
            </Form.Item>
            {/* #261-12a: popularity on publish - the server injects ~9997 viewers plus rule-driven simulated bids */}
            <Form.Item label="Demo crowd" name="demoCrowd" valuePropName="checked" tooltip="Once the auction starts the system injects about 9997 viewers and rule-driven random bids (they stop before the cap, leaving the hammer to real people)">
              <Switch checkedChildren="Auto" unCheckedChildren="Off" />
            </Form.Item>
          </Space>
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" size="large" icon={<RocketOutlined />} loading={busy} onClick={onPublish}>Publish and go live</Button>
            <Button size="large" icon={<SaveOutlined />} onClick={onSaveDraft}>Save draft{drafts.length > 0 ? ` (${drafts.length})` : ''}</Button>
          </Space>

          {/* Draft box: only shows when drafts exist, right under the save-draft button so it is visible immediately. */}
          {drafts.length > 0 && (
            <div className="draft-box">
              <div className="draft-box-head">
                <span className="draft-box-title"><FolderOpenOutlined /> Draft box</span>
                <span className="draft-box-count">{drafts.length}</span>
                <span className="draft-box-hint">Stored in this browser - load one to keep editing</span>
              </div>
              {drafts.map((d) => (
                <div key={d.id} className={'draft-item' + (d.id === draftId ? ' editing' : '')}>
                  <img
                    className="draft-thumb"
                    src={d.imageUrl || CAT_IMG[d.category ?? ''] || PROD.watch}
                    alt=""
                    onError={(e) => { e.currentTarget.src = CAT_IMG[d.category ?? ''] ?? PROD.watch; }}
                  />
                  <div className="draft-meta">
                    <div className="draft-name">{d.name}</div>
                    <div className="draft-sub">
                      {CAT_EMOJI[d.category ?? ''] ? `${CAT_EMOJI[d.category ?? '']} ` : ''}{d.category || 'Uncategorized'} - cap ¥{fmtMoney(d.cap ?? 0)} - increment ¥{fmtMoney(d.step ?? 0)} - {d.duration ?? 80}s
                    </div>
                  </div>
                  <span className="draft-time">{fmtSavedAt(d.savedAt)}</span>
                  {d.id === draftId ? (
                    <Tag color="#fe2c55" style={{ marginInlineEnd: 0 }}>Editing</Tag>
                  ) : (
                    <Button size="small" type="primary" ghost onClick={() => onLoadDraft(d)}>Load</Button>
                  )}
                  <Popconfirm title="Delete this draft?" okText="Delete" cancelText="Keep" okButtonProps={{ danger: true }} onConfirm={() => onDeleteDraft(d.id)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="Delete draft" />
                  </Popconfirm>
                </div>
              ))}
            </div>
          )}
        </Form>
        <div className="pub-preview">
          <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>Mobile live-room preview</div>
          <div className="pub-phone">
            <div style={{ fontSize: 12, opacity: 0.85 }}>Auction ends in {String(Math.floor((v.duration ?? 80) / 60)).padStart(2, '0')}:{String((v.duration ?? 80) % 60).padStart(2, '0')}</div>
            <img className="pub-img" src={previewImg} alt="" />
            <div className="pub-card">
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{v.name || 'The product name will appear here'}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <div><div style={{ fontSize: 10, opacity: 0.7 }}>{v.start === 0 ? 'Starts at zero' : 'Start price'}</div><div style={{ fontSize: 18, fontWeight: 800 }}>¥{fmtMoney(v.start ?? 0)}</div></div>
                <div style={{ textAlign: 'right' }}><div style={{ fontSize: 10, opacity: 0.7 }}>Increment</div><div style={{ fontSize: 18, fontWeight: 800 }}>¥{fmtMoney(step)}</div></div>
              </div>
              <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 8 }}>{(v.cap ?? 0) > 0 ? `Cap ¥${fmtMoney(v.cap)}` : 'No cap'} - {v.autoExtend ? `extends ${v.extendSec ?? 15}s` : 'no extension'}</div>
            </div>
            <div className="pub-cta">Bid now ¥{fmtMoney((v.start ?? 0) + step)}</div>
          </div>
          <div style={{ fontSize: 11.5, color: '#aaa', marginTop: 10, lineHeight: 1.6 }}>The preview updates live with the form. After publishing, this card appears in the host's live room, and a buyer can bid once they tap "Join" and accept the terms.</div>
        </div>
      </div>
    </div>
  );
}
