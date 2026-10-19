/* Local documentation interactions. No services, data collection or persistence. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const rootStyle = getComputedStyle(document.documentElement);
  const token = name => rootStyle.getPropertyValue(`--ghost-${name}`).trim();
  const icon = (name, small = true) => `<svg class="g-icon${small ? ' g-icon--small' : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  let toastTimer;
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').dataset.open = 'true';
    toastTimer = setTimeout(() => { $('toast').dataset.open = 'false'; }, 2600);
  }
  async function copy(text, success = '已复制') {
    try {
      await navigator.clipboard.writeText(text);
      toast(success);
    } catch {
      const previous = document.activeElement;
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('aria-label', '待复制内容');
      field.style.cssText = 'position:fixed;left:-10000px;top:0';
      document.body.append(field);
      field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Show a useful fallback below. */ }
      field.remove();
      previous?.focus({ preventScroll: true });
      toast(copied ? success : '无法自动复制，请选中页面中的文字复制。');
    }
  }

  const colors = [
    ['主要文字', 'text-primary'], ['次要文字', 'text-secondary'],
    ['辅助文字', 'text-muted'], ['禁用文字', 'text-disabled'],
    ['页面背景', 'bg-canvas'], ['独立表面', 'bg-surface'],
    ['浅底容器', 'bg-subtle'], ['轻量边界', 'border-subtle'],
  ];
  for (const [label, name] of colors) {
    const value = token(name);
    const button = document.createElement('button');
    button.className = 'ds-swatch';
    button.type = 'button';
    button.style.setProperty('--swatch', value);
    button.setAttribute('aria-label', `复制${label}变量，${value}`);
    button.innerHTML = `<span class="ds-swatch-color"></span><span class="g-label">${label}<code>${value}</code></span><span class="ds-token-key">${name}</span>`;
    button.addEventListener('click', () => copy(`var(--ghost-${name})`, `已复制 ${name} · ${value}`));
    $('colorTokens').append(button);
  }
  document.querySelectorAll('[data-type-spec]').forEach(label => {
    const sample = label.closest('.ds-type-row').lastElementChild;
    const style = getComputedStyle(sample);
    label.textContent = `${parseFloat(style.fontSize)} / ${parseFloat(style.lineHeight)} · ${style.fontWeight}`;
  });
  for (const n of [1, 2, 3, 4, 6, 8, 10]) {
    const value = token(`space-${n}`);
    const row = document.createElement('div');
    row.className = 'ds-space-item';
    row.innerHTML = `<code>${n * 4}</code><span class="ds-space-bar" style="--space:${value}"></span><code>${n}×</code>`;
    $('spacingScale').append(row);
  }

  const states = [['default', '默认'], ['hover', '悬停'], ['pressed', '按下'], ['focus', '聚焦'], ['disabled', '禁用'], ['loading', '加载']];
  for (const [kind, label] of [['secondary', '文字操作'], ['primary', '重点文字'], ['solid', '独立确认']]) {
    const row = document.createElement('div');
    row.className = 'ds-state-row';
    row.innerHTML = `<span class="g-label">${label}</span>`;
    for (const [state, name] of states) {
      const cell = document.createElement('div');
      cell.className = 'ds-state-cell';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `g-btn${kind === 'secondary' ? '' : ` g-btn--${kind}`}`;
      button.dataset.state = state;
      button.setAttribute('aria-label', `${label}，${name}状态示例`);
      button.disabled = state === 'disabled';
      if (state === 'loading') {
        button.setAttribute('aria-busy', 'true');
        button.setAttribute('aria-disabled', 'true');
        button.innerHTML = '<span class="g-spinner" aria-hidden="true"></span>加载';
      } else {
        button.textContent = kind === 'solid' ? '确认' : kind === 'primary' ? '继续' : '调整';
      }
      button.addEventListener('click', () => { if (state !== 'loading') toast(`${label} · ${name}样例`); });
      const caption = document.createElement('span');
      caption.textContent = name;
      cell.append(caption, button);
      row.append(cell);
    }
    $('buttonStates').append(row);
  }

  $('liveAction').addEventListener('click', async () => {
    const button = $('liveAction');
    if (button.getAttribute('aria-busy') === 'true') return;
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    button.innerHTML = '<span class="g-spinner" aria-hidden="true"></span>处理中';
    $('actionStatus').textContent = '处理中…';
    await new Promise(resolve => setTimeout(resolve, 1000));
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-disabled');
    button.innerHTML = `${icon('check')}再试一次`;
    $('actionStatus').textContent = '已完成';
  });
  $('invalidInput').addEventListener('input', event => {
    const valid = Boolean(event.target.value.trim());
    event.target.setAttribute('aria-invalid', String(!valid));
    $('invalidHint').innerHTML = `${icon(valid ? 'check' : 'info')}<span>${valid ? '内容已填写。' : '请填写内容后继续。'}</span>`;
  });
  document.querySelectorAll('[data-sample-action]').forEach(button => {
    button.addEventListener('click', () => toast('排版样本 · 文字操作反馈'));
  });
  $('composerInput').addEventListener('input', event => {
    $('composerSend').disabled = !event.target.value.trim();
  });
  $('composerDemo').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('composerInput').value.trim()) return;
    $('composerInput').value = '';
    $('composerSend').disabled = true;
    $('composerStatus').textContent = '已展示发送反馈，输入区恢复为空闲状态。';
    $('composerInput').focus();
  });

  const tabs = [...document.querySelectorAll('.g-tab')];
  function selectTab(tab, moveFocus = false) {
    tabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !selected;
    });
    if (moveFocus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const targets = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (event.key in targets) { event.preventDefault(); selectTab(tabs[targets[event.key]], true); }
    });
  });

  const sheet = $('demoSheet');
  let sheetTrigger;
  function openSheet() {
    sheetTrigger = document.activeElement;
    sheet.showModal();
    document.body.classList.add('ds-modal-open');
  }
  $('openSheet').addEventListener('click', openSheet);
  $('closeSheet').addEventListener('click', () => sheet.close());
  $('confirmSheet').addEventListener('click', () => sheet.close());
  sheet.addEventListener('close', () => { document.body.classList.remove('ds-modal-open'); sheetTrigger?.focus({ preventScroll: true }); });
  let backdropPointer = false;
  const outsideSheet = event => {
    const box = sheet.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  sheet.addEventListener('pointerdown', event => { backdropPointer = event.target === sheet && outsideSheet(event); });
  sheet.addEventListener('click', event => { if (backdropPointer && event.target === sheet && outsideSheet(event)) sheet.close(); backdropPointer = false; });
  document.querySelectorAll('[data-demo]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.demo === 'more' || button.dataset.demo === 'list') openSheet();
    else if (button.dataset.demo === 'copy') copy('给重要的内容，一点空间。', '示例文字已复制');
    else toast('添加按钮的点击反馈');
  }));

  const contents = {
    short: { title: '给想法留一点空间', body: '一段清楚的说明，搭配必要的信息。文字和操作，都保持自己的节奏。', value: '自然换行，按需展开' },
    long: { title: '当标题变长，内容依然应该拥有清楚而从容的阅读节奏', body: '这是一段较长的内容样例，用来检查窄屏下的阅读体验。标题可以自然折行，正文维持固定的字号与行高。辅助信息留在自己的位置，操作区随着内容向下延伸。\n\n容器的高度由内容决定，不因为文字增加而缩小字号，也不截断需要阅读的信息。', value: '这是一项较长的说明，换行以后仍然与左侧标签保持清晰的对应关系。' },
    mixed: { title: '让中文、English 与数字 0123456789 自然共处', body: 'A quiet space for every idea. 中英文混排使用同一组语义样式。连续字符串也应留在容器里：ghost_content_generation_preview_component_with_a_very_long_identifier_2026', value: 'DesignSystemContentCompositionWithoutForcedTruncation' },
  };
  function element(tag, className, text, slot) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    if (slot) node.dataset.slot = slot;
    return node;
  }
  function renderComposition(announce = true) {
    const selected = new Set([...document.querySelectorAll('input[name="slot"]:checked')].map(input => input.value));
    const content = contents[$('lengthControl').value];
    const preview = $('compositionPreview');
    preview.replaceChildren();
    preview.dataset.surface = $('surfaceControl').value;
    const surfaceNotes = { plain: '连续阅读默认无边界，以留白分组。', subtle: '只强调一个局部内容组，内部不再叠加表面。', outline: '用于独立引用或附件，内部不再嵌套边框。' };
    $('surfaceHint').textContent = surfaceNotes[preview.dataset.surface];
    const contentGap = parseFloat(token('content-gap'));
    const headingGap = parseFloat(token('heading-gap'));
    document.querySelector('.ds-stage-foot').textContent = `${preview.dataset.surface === 'plain' ? '无额外内边距' : `内边距 ${parseFloat(token('surface-inset'))}`} · 模块间距 ${contentGap} · 标题组间距 ${headingGap}`;
    $('previewWidth').dataset.width = $('widthControl').value;
    preview.classList.toggle('ds-show-guides', $('guideControl').checked);
    if (selected.has('label') || selected.has('title')) {
      const head = element('header', 'g-content-head', '', `标题组 / ${headingGap}`);
      if (selected.has('label')) head.append(element('p', 'g-label g-muted', '内容样例 · CONTENT'));
      if (selected.has('title')) head.append(element('h3', 'g-title', content.title));
      preview.append(head);
    }
    if (selected.has('body')) {
      const group = element('div', 'g-prose', '', '正文');
      content.body.split('\n\n').forEach(text => group.append(element('p', 'g-detail g-secondary', text)));
      preview.append(group);
    }
    if (selected.has('metric')) {
      const metric = element('div', 'g-metric', '', '关键数值');
      metric.append(element('strong', '', '24'), element('span', 'g-label g-muted', '项 · 数值样例'));
      preview.append(metric);
    }
    if (selected.has('media')) {
      const media = element('div', 'g-media g-label', '媒体区域 · 16:9', '媒体');
      media.setAttribute('role', 'img'); media.setAttribute('aria-label', '十六比九媒体占位区域');
      preview.append(media);
    }
    if (selected.has('details')) {
      const details = element('dl', 'g-kv', '', '键值信息');
      for (const [label, value] of [['呈现方式', content.value], ['模块间距', `${contentGap}px`]]) {
        const row = element('div'); row.append(element('dt', '', label), element('dd', '', value)); details.append(row);
      }
      preview.append(details);
    }
    if (selected.has('meta')) preview.append(element('p', 'g-label g-muted', '这是一条辅助说明，用来交代内容的来源。', '辅助说明'));
    if (selected.has('actions')) {
      const actions = element('div', 'g-actions g-actions--text', '', '操作区');
      const primary = element('button', 'g-btn g-btn--primary', '主要操作'); primary.type = 'button';
      const secondary = element('button', 'g-btn g-btn--quiet', '次要操作'); secondary.type = 'button';
      primary.addEventListener('click', () => toast('主要操作样例'));
      secondary.addEventListener('click', () => toast('次要操作样例'));
      actions.append(primary, secondary); preview.append(actions);
    }
    if (!selected.size) preview.append(element('p', 'g-label g-muted', '暂无内容。选择内容模块，开始组合。'));
    const clone = preview.cloneNode(true);
    clone.removeAttribute('id'); clone.removeAttribute('aria-label'); clone.classList.remove('ds-show-guides');
    clone.querySelectorAll('[data-slot]').forEach(node => node.removeAttribute('data-slot'));
    const lines = [];
    function format(node, depth) {
      const pad = '  '.repeat(depth);
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      const attributes = [...node.attributes].map(attr => ` ${attr.name}="${attr.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
      if (!node.children.length) lines.push(`${pad}<${tag}${attributes}>${node.innerHTML}</${tag}>`);
      else { lines.push(`${pad}<${tag}${attributes}>`); [...node.children].forEach(child => format(child, depth + 1)); lines.push(`${pad}</${tag}>`); }
    }
    format(clone, 1);
    $('compositionCode').textContent = `<div class="ghost-ui">\n${lines.join('\n')}\n</div>`;
    if (announce) $('compositionStatus').textContent = `预览已更新，${selected.size} 个内容模块，${$('lengthControl').selectedOptions[0].textContent}。`;
  }
  $('compositionControls').addEventListener('change', () => renderComposition());
  $('compositionControls').addEventListener('submit', event => event.preventDefault());
  $('compositionControls').addEventListener('reset', () => requestAnimationFrame(() => renderComposition()));
  $('copyComposition').addEventListener('click', () => copy($('compositionCode').textContent, '组合 HTML 已复制'));
  new ResizeObserver(entries => { $('previewSize').textContent = `${Math.round(entries[0].contentRect.width)}px · 实际宽度`; }).observe($('previewWidth'));
  new ResizeObserver(entries => { $('specimenWidth').textContent = `排版基准 / ${Math.round(entries[0].contentRect.width)}px`; }).observe(document.querySelector('.ds-specimen-wrap'));
  renderComposition(false);

  const navLinks = [...document.querySelectorAll('.ds-nav a')];
  const sections = navLinks.map(link => document.querySelector(link.hash));
  function highlightSection() {
    let current = sections[0];
    for (const section of sections) if (section.getBoundingClientRect().top <= 140) current = section;
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections.at(-1);
    navLinks.forEach(link => { if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
  }
  let scrollScheduled = false;
  window.addEventListener('scroll', () => {
    if (!scrollScheduled) { scrollScheduled = true; requestAnimationFrame(() => { highlightSection(); scrollScheduled = false; }); }
  }, { passive: true });
  highlightSection();
})();
