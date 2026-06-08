import { Form, Input, InputNumber, Select, Switch, Button, Upload, Divider, Space, Alert, App as AntdApp } from 'antd';
import { PlusOutlined, RocketOutlined, SaveOutlined } from '@ant-design/icons';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';

const CAT_EMOJI: Record<string, string> = { 玉石珠宝: '🧿', 翡翠玉镯: '💚', 二手奢侈品: '⌚️', 文玩杂项: '🫖', 钱币邮票: '🪙', 艺术品: '🎴', 特色食品: '🍫' };
const CAT_IMG: Record<string, string> = { 玉石珠宝: PROD.jadePendant, 翡翠玉镯: PROD.jadeBangle, 二手奢侈品: PROD.watch, 文玩杂项: PROD.teapot, 钱币邮票: PROD.goldNecklace, 艺术品: PROD.diamond, 特色食品: PROD.chocolate };

export default function AuctionPublish() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const v = Form.useWatch([], form) || {};
  const previewImg = CAT_IMG[v.category as string] ?? PROD.jadePendant;
  const step = v.step ?? 50;

  const onPublish = () => {
    form.validateFields().then(() => message.success('竞拍已发布，移动端直播间已同步上架 🎉')).catch(() => message.error('请完善必填项与规则配置'));
  };

  return (
    <div className="admin-content">
      <Alert type="info" showIcon style={{ marginBottom: 18 }} message="发布即生成竞拍状态机：上架 → 竞拍中 → 截拍中 → 成交/流拍。规则一经有人出价不可再改，请提前配置好。" />
      <div className="pub-grid">
        <Form form={form} layout="vertical" initialValues={{ category: '玉石珠宝', start: 0, step: 50, minStep: 50, cap: 12000, duration: 80, autoExtend: true, extendSec: 15, deposit: 200 }}>
          <Divider orientation="left" plain>商品信息</Divider>
          <Form.Item label="商品主图" required>
            <Upload listType="picture-card" beforeUpload={() => false} maxCount={4}>
              <div><PlusOutlined /><div style={{ marginTop: 6 }}>上传</div></div>
            </Upload>
          </Form.Item>
          <Form.Item label="商品名称" name="name" rules={[{ required: true, message: '请输入商品名称' }]}>
            <Input placeholder="如：金镶玉平安扣·和田玉吊坠项链首饰" maxLength={60} showCount />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="商品分类" name="category" style={{ flex: 1 }}>
              <Select options={Object.keys(CAT_EMOJI).map((c) => ({ label: `${CAT_EMOJI[c]} ${c}`, value: c }))} />
            </Form.Item>
            <Form.Item label="保证金" name="deposit" style={{ flex: 1 }} tooltip="参与冻结，成交付款后退回；弃标扣除">
              <InputNumber min={0} step={50} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item label="商品介绍" name="intro">
            <Input.TextArea rows={2} placeholder="材质、成色、证书、瑕疵说明等" maxLength={200} showCount />
          </Form.Item>
          <Divider orientation="left" plain>竞拍规则</Divider>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="起拍价" name="start" style={{ flex: 1 }} tooltip="填 0 即 0 元起拍，人人可参与">
              <InputNumber min={0} step={50} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="封顶价" name="cap" style={{ flex: 1 }} tooltip="出价达到封顶价立即成交">
              <InputNumber min={0} step={500} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="加价幅度（固定）" name="step" style={{ flex: 1 }} rules={[{ required: true }]}>
              <InputNumber min={1} step={10} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="最低加价" name="minStep" style={{ flex: 1 }} tooltip="后台可控；须 ≥ 加价幅度，防止小额加价拖延成交" rules={[({ getFieldValue }) => ({ validator: (_, val) => (val == null || val >= (getFieldValue('step') ?? 0) ? Promise.resolve() : Promise.reject(new Error('最低加价须 ≥ 加价幅度'))) })]}>
              <InputNumber min={1} step={10} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex', alignItems: 'flex-start' }}>
            <Form.Item label="竞拍时长（秒）" name="duration" style={{ flex: 1 }}>
              <InputNumber min={10} step={10} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="结束前自动延时" name="extendSec" style={{ flex: 1 }} tooltip="结束前 10s 内有人出价则延长，10-30s">
              <InputNumber min={10} max={30} step={5} addonAfter="秒" style={{ width: '100%' }} disabled={v.autoExtend === false} />
            </Form.Item>
            <Form.Item label="启用延时" name="autoExtend" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" size="large" icon={<RocketOutlined />} onClick={onPublish}>立即发布开拍</Button>
            <Button size="large" icon={<SaveOutlined />} onClick={() => message.success('已存草稿')}>存草稿</Button>
          </Space>
        </Form>
        <div className="pub-preview">
          <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>移动端直播间预览</div>
          <div className="pub-phone">
            <div style={{ fontSize: 12, opacity: 0.85 }}>距竞拍结束仅剩 {String(Math.floor((v.duration ?? 80) / 60)).padStart(2, '0')}:{String((v.duration ?? 80) % 60).padStart(2, '0')}</div>
            <img className="pub-img" src={previewImg} alt="" />
            <div className="pub-card">
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{v.name || '商品名称将显示在这里'}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <div><div style={{ fontSize: 10, opacity: 0.7 }}>{v.start === 0 ? '0 元起拍' : '起拍价'}</div><div style={{ fontSize: 18, fontWeight: 800 }}>¥{fmtMoney(v.start ?? 0)}</div></div>
                <div style={{ textAlign: 'right' }}><div style={{ fontSize: 10, opacity: 0.7 }}>加价幅度</div><div style={{ fontSize: 18, fontWeight: 800 }}>¥{fmtMoney(step)}</div></div>
              </div>
              <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 8 }}>封顶 ¥{fmtMoney(v.cap ?? 0)} · {v.autoExtend ? `延时 ${v.extendSec ?? 15}s` : '不延时'} · 保证金 ¥{fmtMoney(v.deposit ?? 0)}</div>
            </div>
            <div className="pub-cta">立即出价 ¥{fmtMoney((v.start ?? 0) + step)}</div>
          </div>
          <div style={{ fontSize: 11.5, color: '#aaa', marginTop: 10, lineHeight: 1.6 }}>预览随表单实时更新。发布后该卡片将出现在主播直播间，买家点击「我要参与」签署条款即可出价。</div>
        </div>
      </div>
    </div>
  );
}
