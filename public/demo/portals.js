/* Role-separated portals for the fictional /demo prototype. */
(function () {
  const path = location.pathname.replace(/\/+$/, '');
  const portal = path === '/demo/broker' ? 'broker'
    : path === '/demo/driver' ? 'driver'
    : path === '/demo/owner' || path === '/demo/store' ? 'store'
    : 'root';
  const portalRole = { broker: 'admin', store: 'store', driver: 'driver' };
  const rolePortal = { admin: 'broker', store: 'store', driver: 'driver' };
  const portalPath = { broker: '/demo/broker', store: '/demo/owner', driver: '/demo/driver' };
  const roleLabel = { admin: 'Broker operations', store: 'Store owner', driver: 'Driver' };
  const roleIcon = { admin: 'grid', store: 'store', driver: 'truck' };
  const homeFor = role => role === 'admin' ? 'dispatch' : role === 'driver' ? 'ontrip' : 'dashboard';

  const info = {
    broker: {
      label: 'BROKER OPERATIONS', short: 'Broker operations',
      hero: 'Every load.<br>Every driver.<br><span>One desk.</span>',
      copy: 'Quote customers, dispatch approved drivers and keep every delivery moving.',
      foot: ['Quote', 'Dispatch', 'Resolve'],
      notice: 'This demo broker desk is a preview. In the live platform broker accounts are created by the YYC administrator.',
      canRegister: false
    },
    store: {
      label: 'STORE OWNER WORKSPACE', short: 'Store owner',
      hero: 'Your goods.<br>Your route.<br><span>In view.</span>',
      copy: 'Request deliveries, accept quotations and follow your shipments from one place.',
      foot: ['Request', 'Accept', 'Receive'],
      notice: 'Demo only. Anything you enter is fictional, stays in this browser session and resets on refresh.',
      canRegister: true
    },
    driver: {
      label: 'DRIVER WORKSPACE', short: 'Driver',
      hero: 'Your truck.<br>Your next job.<br><span>On the road.</span>',
      copy: 'See offers, manage assigned work and record delivery evidence from your own workspace.',
      foot: ['Accept', 'Drive', 'Prove delivery'],
      notice: 'Demo only. Driver approval is simulated; nothing is uploaded, verified or saved.',
      canRegister: true
    }
  };

  navs.admin = [
    ['dispatch', 'route', 'Live dispatch'],
    ['shipments', 'box', 'Deliveries'],
    ['schedule', 'clock', 'Dispatch schedule'],
    ['alerts', 'bell', 'Alerts'],
    ['exceptions', 'bell', 'Exception queue'],
    ['approvals', 'user', 'Approvals'],
    ['activity', 'clock', 'Activity']
  ];
  navs.store = [
    ['dashboard', 'grid', 'Overview'],
    ['shipments', 'box', 'My deliveries'],
    ['booking', 'plus', 'New delivery'],
    ['tracking', 'route', 'Track delivery'],
    ['profile', 'store', 'My store']
  ];
  navs.driver = [
    ['ontrip', 'truck', 'On the road'],
    ['offers', 'box', 'Job offers'],
    ['shipments', 'route', 'My jobs'],
    ['profile', 'truck', 'My truck']
  ];

  // The demo previously exposed a shared role switcher. Keeping it would
  // undermine the separated portals, so it is retired in portal mode.
  switchRole = function () {};

  function chooser() {
    page = 'auth';
    document.body.dataset.role = '';
    document.title = 'Choose your demo portal · YYC Brokers';
    $('#overlay').innerHTML = '';
    $('#root').innerHTML = `<div class="portalchooser">
      <header class="pchooserhead">${logo()}<div class="pchooserlinks"><a class="textbtn" href="/">Open server-backed app →</a></div></header>
      <main class="pchooserbody">
        <div class="pchooserintro">
          <span class="eyebrow">YYC BROKERS · INTERACTIVE DEMO</span>
          <h1>Choose your portal.</h1>
          <p>Each role now has its own sign-in, dashboard and navigation. Records are fictional and shared across the demo so you can follow one delivery between portals.</p>
        </div>
        <div class="portalcards">
          <a class="portalcard store" href="/demo/owner">
            <span class="portalicon">${icon('store')}</span>
            <span class="eyebrow">STORE OWNER</span>
            <h2>Request and receive.</h2>
            <p>Book demo deliveries, review quotations and follow shipments to your store.</p>
            <span class="portalgo">Open store portal →</span>
          </a>
          <a class="portalcard driver" href="/demo/driver">
            <span class="portalicon">${icon('truck')}</span>
            <span class="eyebrow">DRIVER</span>
            <h2>Accept and drive.</h2>
            <p>See job offers, manage your shift and record demo delivery evidence.</p>
            <span class="portalgo">Open driver portal →</span>
          </a>
          <a class="portalcard broker" href="/demo/broker">
            <span class="portalicon">${icon('grid')}</span>
            <span class="eyebrow">BROKER OPERATIONS</span>
            <h2>Quote and dispatch.</h2>
            <p>Price work, assign drivers and review exceptions from the operations desk.</p>
            <span class="portalgo">Open broker portal →</span>
          </a>
        </div>
        <p class="portalnote">Demo only · Fictional records · No real authentication, payments or GPS.</p>
      </main>
    </div>`;
  }

  function decorateAuth(cfg) {
    document.body.dataset.role = portal;
    document.title = `${cfg.short} demo · YYC Brokers`;
    const hero = $('.hero');
    if (hero) {
      const eyebrow = hero.querySelector('.eyebrow');
      if (eyebrow) eyebrow.textContent = cfg.label;
      const h1 = hero.querySelector('h1');
      if (h1) h1.innerHTML = cfg.hero;
      const p = hero.querySelector('p');
      if (p) p.textContent = cfg.copy;
      const foot = hero.querySelector('.herofoot');
      if (foot) foot.innerHTML = cfg.foot.map((label, i) => `<span>0${i + 1} &nbsp; ${E(label)}</span>`).join('');
    }
    const header = $('.authright header');
    if (header) header.innerHTML = `<a class="textbtn" href="/demo/?switch=1">← All demo portals</a><span>${cfg.label}</span>`;
    const eyebrow = $('.authbox .eyebrow');
    if (eyebrow) eyebrow.textContent = `${cfg.label} · ${authMode === 'register' ? 'CREATE DEMO PROFILE' : 'DEMO SIGN IN'}`;
    const heading = $('.authbox > h1');
    if (heading) heading.textContent = authMode === 'register' ? `Create your ${portal} account.` : `Sign in to the ${portal === 'broker' ? 'broker desk' : portal + ' workspace'}.`;
    const intro = $('.authbox > p.muted');
    if (intro) intro.textContent = authMode === 'register'
      ? 'This is a fictional demo profile; nothing is stored or verified.'
      : portal === 'broker' ? 'Use the operations desk to quote, dispatch and resolve exceptions.'
        : portal === 'store' ? 'Manage your delivery requests, quotations and receipts.'
          : 'See your offers, assigned jobs and delivery records.';
    const notice = $('.authbox .notice');
    if (notice) notice.textContent = cfg.notice;
    if (authMode === 'login') {
      const form = $('.authbox form');
      const submit = form?.querySelector('button[type="submit"]') || form?.querySelector('button:last-child');
      if (submit) submit.innerHTML = `Open ${portal === 'broker' ? 'broker' : portal} demo ${icon('arrow')}`;
    }
    $('.authbox .row.between.wrap')?.remove();
    const roles = $('.authbox .roles');
    if (roles) {
      roles.classList.add('singlerole');
      roles.innerHTML = `<button type="button" class="role selected">${icon(roleIcon[portalRole[portal]])}<b>${roleLabel[portalRole[portal]]}</b><small>${portal === 'store' ? 'I need goods delivered' : portal === 'driver' ? 'I have a truck for deliveries' : 'I manage operations'}</small></button>`;
    }
    if (!cfg.canRegister) {
      $('.authbox .switch')?.remove();
      $('.authbox .roles')?.remove();
      if (authMode === 'register') {
        authMode = 'login';
        auth();
        return;
      }
    }
  }

  const baseAuth = auth;
  auth = function () {
    if (portal === 'root') { chooser(); return; }
    authRole = portalRole[portal];
    if (portal === 'broker') authMode = 'login';
    baseAuth();
    decorateAuth(info[portal]);
  };

  const baseEnterDemo = enterDemo;
  enterDemo = function (r) {
    if (portal !== 'root' && r !== portalRole[portal]) r = portalRole[portal];
    baseEnterDemo(r);
    page = homeFor(r);
    render();
  };

  const baseLogin = login;
  login = function (e) {
    authRole = portalRole[portal] || authRole;
    baseLogin(e);
    if (portal !== 'root') { page = homeFor(role); $('#overlay').innerHTML = ''; render(); }
  };

  const baseNav = nav;
  nav = function (p) {
    if (!(navs[role] || []).some(item => item[0] === p)) p = homeFor(role);
    return baseNav(p);
  };

  function decorateApp() {
    const key = rolePortal[role];
    document.body.dataset.role = key || '';
    const cfg = info[key];
    if (!cfg) return;
    document.title = `${cfg.short} demo · YYC Brokers`;
    document.querySelector('.rolepicker')?.remove();
    document.querySelector('.commandbar')?.remove();
    const row = document.querySelector('.main .top .row');
    if (row && !row.querySelector('.portalswitch')) {
      const link = document.createElement('a');
      link.className = 'portalswitch';
      link.href = '/demo/?switch=1';
      link.innerHTML = `<b>${cfg.short}</b><span>Switch demo portal →</span>`;
      row.prepend(link);
    }
    const breadcrumb = document.querySelector('.main .top > .muted');
    if (breadcrumb) {
      const label = (navs[role] || []).find(item => item[0] === page)?.[2] || 'Workspace';
      breadcrumb.innerHTML = `${E(cfg.short)} &nbsp; / &nbsp; <b>${E(label)}</b>`;
    }
    const side = document.querySelector('.sidebottom');
    if (side) side.innerHTML = `<b>${cfg.short}</b><br>YYC Brokers demo<br><span style="color:#e5b975">Fictional records</span><button class="textbtn" style="color:#b8cbb9;padding:15px 0 0;display:block" onclick="auth()">${icon('exit')} Exit to login</button>`;
  }

  function storeShipmentsPage() {
    const list = own();
    const quotes = list.filter(s => s.status === 'Quote ready');
    const moving = list.filter(s => s.status === 'In transit');
    const done = list.filter(s => s.status === 'Delivered');
    return title('My deliveries', 'Every request your store has sent, from quotation to delivery.', '<button class="btn" onclick="nav(\'booking\')">＋ Request delivery</button>')
      + stats([
        ['All requests', 'Demo requests', list.length, 'box'],
        ['Quotes to review', 'Waiting for your response', quotes.length, 'file'],
        ['In transit', 'Goods picked up', moving.length, 'truck'],
        ['Delivered', 'Evidence recorded', done.length, 'check']
      ])
      + `<section class="card"><div class="row between"><h2>Delivery history</h2><button class="textbtn" onclick="nav('tracking')">Track active deliveries →</button></div>${table(list)}</section>`
      + `<div class="notice">Demo only. Only deliveries requested by your store appear in this portal.</div>`;
  }

  function driverJobsPage() {
    const list = own();
    const active = list.filter(s => !['Delivered', 'Cancelled'].includes(s.status));
    const done = list.filter(s => s.status === 'Delivered');
    const offers = shipments.filter(s => s.status === 'Offered');
    return title('My jobs', 'Accepted work, completed deliveries and the records attached to your truck.', `<button class="btn" onclick="nav('offers')">View offers (${offers.length})</button>`)
      + stats([
        ['Active jobs', 'Assigned to your truck', active.length, 'truck'],
        ['Completed', 'Delivery evidence recorded', done.length, 'check'],
        ['Agreed rates', 'Completed work · not payouts', money(done.reduce((total, s) => total + (Number(s.rate) || 0), 0)), 'file'],
        ['Offers waiting', 'Direct offers to you', offers.length, 'box']
      ])
      + `<div class="grid2">${active.length ? active.map(s => `<section class="card"><div class="row between"><h2>${E(s.id)}</h2>${badge(s.status)}</div>${route(s)}<p class="muted" style="margin-top:12px">${E(s.goods)} · ${money(s.rate)} agreed driver rate</p><p class="muted">${E(s.date)} · ${E(s.window)}</p><button class="btn light" style="margin-top:14px" onclick="openDelivery('${E(s.id)}')">Open job →</button></section>`).join('') : '<section class="card empty full"><h2>No active job.</h2><p>Accepted jobs appear here until delivery is recorded.</p><button class="btn" onclick="nav(\'offers\')">View job offers</button></section>'}</div>`
      + `<section class="card" style="margin-top:20px"><h2>Completed work</h2>${done.length ? done.map(s => `<div class="activity"><span><b>${E(s.id)}</b> · ${E(s.destination)}<br><small>${E(s.date)} · receipt ${E(s.pod || 'not recorded')}</small></span><button class="btn light small" onclick="openDelivery('${E(s.id)}')">Open record</button></div>`).join('') : '<p class="muted" style="margin-top:12px">No completed deliveries yet.</p>'}</section>`;
  }

  function brokerShipmentsPage() {
    const list = shipments;
    const active = list.filter(s => !['Delivered', 'Cancelled'].includes(s.status));
    const exceptions = list.filter(s => s.issue && !s.issue.resolved);
    return title('Delivery board', 'Search, filter and open every request in the demo brokerage.', '<button class="btn light" onclick="nav(\'dispatch\')">Back to dispatch</button>')
      + stats([
        ['Active deliveries', 'In the network', active.length, 'truck'],
        ['Awaiting quote', 'Needs a quotation', list.filter(s => s.status === 'Awaiting quote').length, 'clock'],
        ['Ready to assign', 'Choose a driver', list.filter(s => s.status === 'Ready to assign').length, 'box'],
        ['Open exceptions', 'Need follow-up', exceptions.length, 'bell']
      ])
      + `<section class="card"><div class="row between"><h2>All deliveries</h2><button class="textbtn" onclick="nav('schedule')">Open dispatch schedule →</button></div>${table(list)}</section>`;
  }

  function brokerSchedulePage() {
    const groups = [
      ['Awaiting decision', ['Awaiting quote', 'Quote ready']],
      ['Ready to dispatch', ['Ready to assign', 'Offered']],
      ['On the road', ['Assigned', 'In transit']],
      ['Completed', ['Delivered', 'Cancelled']]
    ];
    const jobs = shipments.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    return title('Dispatch schedule', 'Every demo delivery grouped by the next operational state.')
      + `<div class="schedulegrid" style="grid-template-columns:repeat(2,1fr)">${groups.map(([name, states]) => {
        const list = jobs.filter(s => states.includes(s.status));
        return `<section class="schedulecolumn"><div class="row between"><h3>${name}</h3><span class="tag gray">${list.length}</span></div>${list.length ? list.map(s => `<button class="schedulejob" onclick="openDelivery('${E(s.id)}')"><div class="row between">${badge(s.status)}<time>${E(s.date || 'No date')}</time></div><b>${E(s.id)} · ${E(s.customer)}</b><p>${E(s.pickup)}<br>→ ${E(s.destination)}<br>${E(s.window || 'Flexible')} · ${s.pallets} pallets · ${s.kg} kg</p><div class="row between" style="margin-top:13px;font-size:10px"><span>${s.driver ? E(driverProfile.name) : 'Driver not assigned'}</span><span style="color:#537448">Open →</span></div></button>`).join('') : '<div class="emptylane">Nothing in this state.</div>'}</section>`;
      }).join('')}</div>`;
  }

  function brokerExceptionQueue() {
    const open = shipments.filter(s => s.issue && !s.issue.resolved);
    return title('Exception queue', 'Open delivery exceptions that need a broker decision.', '<button class="btn light" onclick="nav(\'alerts\')">Back to alerts</button>')
      + `<div class="grid2">${open.length ? open.map(s => `<section class="card"><div class="row between"><h2>${E(s.id)} · ${E(s.issue.reason)}</h2><span class="tag amber">OPEN</span></div><p style="margin-top:12px">${E(s.issue.note)}</p><button class="btn" onclick="openDelivery('${E(s.id)}')">Review and resolve</button></section>`).join('') : '<section class="card empty full"><h2>No open exceptions.</h2><p>Issues reported by drivers during a delivery appear here.</p></section>'}</div>`;
  }

  const baseContent = content;
  content = function () {
    if (role === 'admin') {
      if (page === 'shipments') return brokerShipmentsPage();
      if (page === 'schedule') return brokerSchedulePage();
      if (page === 'exceptions') return brokerExceptionQueue();
    }
    if (role === 'store' && page === 'shipments') return storeShipmentsPage();
    if (role === 'driver' && page === 'shipments') return driverJobsPage();
    return baseContent();
  };

  const baseRender = render;
  render = function () {
    if (portal === 'root') { chooser(); return; }
    if (page === 'auth') return;
    baseRender();
    decorateApp();
  };

  if (portal === 'root') chooser();
  else auth();
})();
