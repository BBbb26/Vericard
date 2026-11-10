'use strict';

(() => {
  const paths = {
    brand: ['M4 7a2 2 0 0 1 2-2h10l4 4v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M4 10h16M8 14l2 2 4-4'],
    grid: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'],
    home: ['m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10'],
    image: ['M4 5h16v14H4zM4 16l5-5 3 3 3-4 5 6M8 8h.01'],
    upload: ['M12 16V4m-5 5 5-5 5 5M4 15v5h16v-5'],
    message: ['M20 11a8 7 0 0 1-8 7H9l-4 3v-5a7 7 0 1 1 15-5zM9 11h.01m3 0h.01m3 0h.01'],
    send: ['m21 3-7 18-3-8-8-3 18-7zm0 0L11 13'],
    check: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8 12l3 3 5-6'],
    chart: ['M4 19h16M6 15v-4M12 15V6M18 15V9'],
    wallet: ['M4 7h13a2 2 0 0 1 2 2v9H6a2 2 0 0 1-2-2V7zm0 0 12-3 1 3m2 4h2v4h-2m-3-2h.01'],
    help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9a3 3 0 0 1 6 0c0 2-3 2.5-3 4m0 4h.01'],
    sidebar: ['M4 5h16v14H4zM9 5v14m4-7h4m-2-2-2 2 2 2'],
    chevron: ['m9 6 6 6-6 6'],
    download: ['M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4'],
    edit: ['M4 18h4L19 7l-4-4L4 14zm9-13 4 4'],
    plus: ['M12 5v14M5 12h14'],
    paid: ['M4 6h16v12H4zM4 10h16m-12 4h4'],
    layers: ['m12 4 8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4'],
    calendar: ['M4 6h16v14H4zM8 3v5m8-5v5M4 11h16m-11 4h3'],
    target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 12h.01'],
    spark: ['M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5zM19 3v4m-2-2h4'],
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.65');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths[name] ?? []) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function create(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function navItem(label, image, href) {
    const item = create(href ? 'a' : 'button', 'shell-link');
    if (href) item.href = href;
    else item.type = 'button';
    item.title = label;
    item.setAttribute('aria-label', label);
    const holder = create('span', 'shell-icon');
    holder.append(icon(image));
    item.append(holder, create('span', 'shell-label', label));
    return item;
  }

  function helpDialog() {
    const dialog = create('dialog', 'shell-dialog');
    dialog.setAttribute('aria-label', '使用帮助');
    dialog.append(create('h2', null, '使用帮助'),
      create('p', null, '在 AI 助手上传套餐截图或输入问题。比较多个买法时，进入套餐比较。实际办卡后，可到我的卡包登记消费和核对扣费。'),
      create('p', 'muted', '分析由本机计算。合成示例用于体验，真实结果以已核对条款和计划输入为依据。'));
    const actions = create('div', 'actions');
    const guide = create('a', 'button secondary', '打开多套餐比较');
    guide.href = 'comparison.html';
    const form = create('form');
    form.method = 'dialog';
    form.append(create('button', 'secondary', '关闭'));
    actions.append(guide, form);
    dialog.append(actions);
    document.body.append(dialog);
    return dialog;
  }

  function mount(container) {
    const brand = create('a', 'app-brand');
    brand.href = '/';
    brand.setAttribute('aria-label', 'Vericard · 对话首页');
    const mark = create('span', 'brand-mark');
    mark.append(icon('brand'));
    const name = create('span', 'brand-label');
    name.append(create('strong', null, 'Vericard'), create('small', null, '套餐决策助手'));
    brand.append(mark, name);

    const navigation = create('nav', 'shell-nav');
    navigation.setAttribute('aria-label', '主要导航');
    const pages = [
      ['agent', 'AI 助手', 'message', '/'],
      ['workspace', '工作台', 'grid', '/home.html'],
      ['comparison', '套餐比较', 'chart', '/comparison.html'],
      ['wallet', '我的卡包', 'wallet', '/wallet.html'],
    ];
    for (const [page, label, image, href] of pages) {
      const item = navItem(label, image, href);
      if (container.dataset.page === page) item.setAttribute('aria-current', 'page');
      navigation.append(item);
    }
    const history = navItem('历史任务', 'calendar', '/home.html#homeRecent');
    history.classList.add('shell-history');
    navigation.append(history);

    const footer = create('div', 'shell-footer');
    const help = navItem('使用帮助', 'help');
    help.addEventListener('click', () => helpDialogInstance.showModal());
    const helpDialogInstance = helpDialog();
    const toggle = navItem('收起导航', 'sidebar');
    toggle.classList.add('shell-collapse');
    const apply = collapsed => {
      document.body.dataset.shellCollapsed = String(collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', collapsed ? '展开导航' : '收起导航');
      toggle.title = collapsed ? '展开导航' : '收起导航';
      toggle.querySelector('.shell-label').textContent = toggle.title;
    };
    let collapsed = false;
    try { collapsed = localStorage.getItem('kdz-shell-collapsed') === 'true'; } catch {}
    apply(collapsed);
    toggle.addEventListener('click', () => {
      const next = document.body.dataset.shellCollapsed !== 'true';
      apply(next);
      try { localStorage.setItem('kdz-shell-collapsed', String(next)); } catch {}
    });
    footer.append(help, toggle);
    container.replaceChildren(brand, navigation, footer);

    const main = document.querySelector('main');
    if (main) {
      if (!main.id) main.id = 'mainContent';
      const skip = create('a', 'skip-link', '跳到主要内容');
      skip.href = '#' + main.id;
      container.before(skip);
    }
  }

  document.querySelectorAll('[data-app-shell]').forEach(mount);
  document.querySelectorAll('[data-icon]').forEach(holder => holder.prepend(icon(holder.dataset.icon)));
  window.KDZUI = { icon };
})();
