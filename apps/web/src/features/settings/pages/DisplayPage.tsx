import { uiPreset, type UiSettings } from '@nexus/shared';
import { useConfig } from '../../../data/config-store';
import { patch } from '../model';
import { Group, PageHeader, Row, Segmented, Slider, Switch, useCompact } from '../ui';

type Desktop = UiSettings['desktop'];
type Mobile = UiSettings['mobile'];
type Mode = 'show' | 'hover' | 'hide';

const MODES: { value: Mode; label: string }[] = [
  { value: 'show', label: '显示' },
  { value: 'hover', label: '悬停时' },
  { value: 'hide', label: '隐藏' },
];

/**
 * 首页显示与布局 (v0.2): what the home page shows, per element, separately for desktop and phone.
 * Changes apply right away; touching any single item switches the preset to 自定义.
 */
export function DisplayPage() {
  const config = useConfig();
  const compact = useCompact();
  const ui = config.settings.ui;
  const { labels } = config.settings.home;
  const d = ui.desktop;
  const m = ui.mobile;
  const setD = (v: Partial<Desktop>) => patch('ui', { preset: 'custom', desktop: { ...d, ...v } });
  const setM = (v: Partial<Mobile>) => patch('ui', { preset: 'custom', mobile: { ...m, ...v } });
  const labelMode: Mode = !labels.desktop ? 'hide' : d.labelsOnHover ? 'hover' : 'show';
  const setLabels = (v: Mode) => {
    patch('home', { labels: { ...labels, desktop: v !== 'hide' } });
    setD({ labelsOnHover: v === 'hover' });
  };

  const mode = (label: string, sub: string | undefined, value: Mode, onChange: (v: Mode) => void) => (
    <Row label={label} sub={sub} stacked>
      <Segmented<Mode> label={label} size={compact ? undefined : 'sm'} value={value} options={MODES} onChange={onChange} />
    </Row>
  );
  const toggle = (label: string, sub: string | undefined, on: boolean, onChange: (v: boolean) => void) => (
    <Row label={label} sub={sub}>
      <Switch label={label} checked={on} onChange={onChange} />
    </Row>
  );

  const phone = (
    <Group title="手机首页">
      {toggle('时钟', undefined, m.clock === 'show', (v) => setM({ clock: v ? 'show' : 'hide' }))}
      {toggle('服务状态', '出现异常时始终显示', m.status === 'show', (v) => setM({ status: v ? 'show' : 'hide' }))}
      {toggle('设置按钮', '隐藏后，长按壁纸空白处即可打开设置', m.settings === 'show', (v) => setM({ settings: v ? 'show' : 'hide' }))}
      {toggle('壁纸名称与署名', '许可要求署名的图片始终显示', m.wallpaperCredit === 'show', (v) => setM({ wallpaperCredit: v ? 'show' : 'hide' }))}
      <Row label="时钟大小" stacked={compact}>
        <Slider label="手机时钟大小" min={70} max={140} unit="%" value={Math.round(m.clockScale * 100)} onChange={(v) => setM({ clockScale: v / 100 })} />
      </Row>
    </Group>
  );

  const desktop = (
    <>
      <Group title="桌面 · 顶部">
        {mode('导航区域', '左上角的标志与导航；悬停时显示＝鼠标移到顶部才出现', d.topbar, (v) => setD({ topbar: v }))}
        {d.topbar !== 'hide' && (
          <>
            {toggle('Nexus 标志', undefined, d.brand, (v) => setD({ brand: v }))}
            {toggle('「首页」导航', undefined, d.navHome, (v) => setD({ navHome: v }))}
            {toggle('「应用」导航', undefined, d.navApps, (v) => setD({ navApps: v }))}
            {toggle('「运行概览」导航', undefined, d.navOverview, (v) => setD({ navOverview: v }))}
          </>
        )}
        {mode('服务状态', '有服务异常时始终显示', d.status, (v) => setD({ status: v }))}
        {mode('设置按钮', '隐藏后仍可按 , 键、右键空白处，或访问 /settings 打开设置', d.settings, (v) => setD({ settings: v }))}
      </Group>
      <Group title="桌面 · 中间">
        {toggle('时钟', '日期在「外观与个性化」中设置', d.clock === 'show', (v) => setD({ clock: v ? 'show' : 'hide' }))}
        {toggle('搜索框', '隐藏后按 / 或 Ctrl+K 唤出', d.search === 'show', (v) => setD({ search: v ? 'show' : 'hide' }))}
        {toggle('快捷方式图标', undefined, d.shortcuts === 'show', (v) => setD({ shortcuts: v ? 'show' : 'hide' }))}
        {mode('快捷方式名称', '悬停时：名称只在鼠标停在图标上时出现', labelMode, setLabels)}
      </Group>
      <Group title="桌面 · 底部">
        {mode('壁纸名称', undefined, d.wallpaperName, (v) => setD({ wallpaperName: v }))}
        {mode('作者与来源', '许可要求署名的图片（如 CC BY-SA、Unsplash）始终显示', d.wallpaperCredit, (v) => setD({ wallpaperCredit: v }))}
        {mode('换一张、收藏等操作', undefined, d.wallpaperActions, (v) => setD({ wallpaperActions: v }))}
      </Group>
      <Group title="桌面 · 布局微调">
        <Row label="搜索面板宽度" sub="窗口较窄时会自动收窄" stacked={compact}>
          <Slider label="搜索面板宽度" min={640} max={960} unit="px" value={d.searchWidth} onChange={(v) => setD({ searchWidth: Math.round(v / 10) * 10 })} />
        </Row>
        <Row label="垂直位置" sub="负数上移，正数下移（占窗口高度的百分比）" stacked={compact}>
          <Slider label="垂直位置" min={-12} max={12} unit="%" value={d.offsetY} onChange={(v) => setD({ offsetY: v })} />
        </Row>
        <Row label="时钟大小" stacked={compact}>
          <Slider label="桌面时钟大小" min={70} max={140} unit="%" value={Math.round(d.clockScale * 100)} onChange={(v) => setD({ clockScale: v / 100 })} />
        </Row>
      </Group>
    </>
  );

  return (
    <div className="flex max-w-[760px] flex-col gap-7">
      <PageHeader title="首页显示与布局" sub="决定首页显示哪些内容。桌面与手机分开设置，改动即时保存；预设只改变显示方式，不会改动应用与快捷方式。" />
      <Group title="预设">
        <Row label="显示方式" sub={ui.preset === 'minimal' ? '只保留时间、搜索与快捷方式；其余移到鼠标附近或长按菜单中' : ui.preset === 'custom' ? '已按下面的选项单独调整' : '默认的完整首页'} stacked>
          <Segmented
            label="首页显示预设"
            value={ui.preset}
            options={[
              { value: 'daily', label: '日常' },
              { value: 'minimal', label: '极简' },
              { value: 'custom', label: '自定义', disabled: ui.preset !== 'custom' },
            ]}
            onChange={(v) => v !== 'custom' && patch('ui', uiPreset(v, ui), v === 'minimal' ? '已切换到极简模式' : '已恢复日常模式')}
          />
        </Row>
      </Group>
      {compact ? (
        <>
          {phone}
          {desktop}
        </>
      ) : (
        <>
          {desktop}
          {phone}
        </>
      )}
    </div>
  );
}
