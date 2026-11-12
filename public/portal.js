/* Role-separated workspaces for the server-backed app: /owner, /driver, /broker. */
(function () {
  const rolePortal = { admin: 'broker', store: 'store', driver: 'driver' };
  const portalPath = { broker: '/broker', store: '/owner', driver: '/driver' };
  const roleLabel = { admin: 'Broker operations', store: 'Store owner', driver: 'Driver' };
  const roleIcon = { admin: 'grid', store: 'store', driver: 'truck' };
  const homeFor = role => role === 'admin' ? 'dispatch' : role === 'driver' ? 'ontrip' : 'dashboard';

  const path = location.pathname.replace(/\/+$/, '');
  const portal = path === '/broker' ? 'broker'
    : path === '/driver' ? 'driver'
    : path === '/owner' || path === '/store' ? 'store'
    : path === '' || path === '/' || path === '/index.html' ? 'root'
    : 'root';
  const switching = new URLSearchParams(location.search).has('switch');

  const info = {
    broker: {
      label: 'BROKER OPERATIONS', short: 'Broker operations',
      title: 'Broker operations · YYC Brokers',
      hero: 'Every load.<br>Every driver.<br><span>One desk.</span>',
      copy: 'Quote customers, dispatch approved drivers and keep every delivery moving.',
      foot: ['Quote', 'Dispatch', 'Resolve'],
      notice: 'Broker accounts are created by the YYC administrator. Contact operations if you need access.',
      canRegister: false
    },
    store: {
      label: 'STORE OWNER WORKSPACE', short: 'Store owner',
      title: 'Store owner · YYC Brokers',
      hero: 'Your goods.<br>Your route.<br><span>In view.</span>',
      copy: 'Request deliveries, accept quotations and follow your shipments from one place.',
      foot: ['Request', 'Accept', 'Receive'],
      notice: 'New store owners can create an account in this portal. You only see your own deliveries and quotes.',
      canRegister: true
    },
    driver: {
      label: 'DRIVER WORKSPACE', short: 'Driver',
      title: 'Driver · YYC Brokers',
      hero: 'Your truck.<br>Your next job.<br><span>On the road.</span>',
      copy: 'See offers, manage assigned work and record delivery evidence from your own workspace.',
      foot: ['Accept', 'Drive', 'Prove delivery'],
      notice: 'New drivers can register here. Broker approval of your driver and truck is required before accepting jobs.',
      canRegister: true
    }
  };

  // Each portal owns its navigation. The broker gets a distinct exception
  // queue and reports, and the driver has a single "On the road" home.
  navs.admin = [
    ['dispatch', 'route', 'Live dispatch'],
    ['shipments', 'box', 'Deliveries'],
    ['schedule', 'clock', 'Dispatch schedule'],
    ['alerts', 'bell', 'Alerts'],
    ['exceptions', 'bell', 'Exception queue'],
    ['approvals', 'user', 'Approvals'],
    ['reports', 'grid', 'Reports'],
    ['accountRequests', 'user', 'Removal requests']
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

  function chooser() {
    page = 'auth';
    document.body.dataset.role = '';
    document.title = 'Choose your workspace · YYC Brokers';
    if (typeof closeDrawer === 'function') closeDrawer();
    const current = sessionUser ? rolePortal[role] : null;
    const continueCard = current
      ? `<a class="portalcontinue" href="${portalPath[current]}">Continue as ${roleLabel[role]} <span>→</span></a>`
      : '';
    $('#root').innerHTML = `<div class="portalchooser">
      <header class="pchooserhead">${logo()}<div class="pchooserlinks"><a class="textbtn" href="/demo/">Open screen demo →</a>${current ? `<button class="textbtn" onclick="logoutAccount()">Log out</button>` : ''}</div></header>
      <main class="pchooserbody">
        <div class="pchooserintro">
          <span class="eyebrow">YYC BROKERS · SEPARATE WORKSPACES</span>
          <h1>Choose your portal.</h1>
          <p>Store owners, drivers and the brokerage each get their own sign-in, dashboard and navigation. You only see the work that belongs to your role.</p>
          ${continueCard}
        </div>
        <div class="portalcards">
          <a class="portalcard store" href="/owner">
            <span class="portalicon">${icon('store')}</span>
            <span class="eyebrow">STORE OWNER</span>
            <h2>Request and receive.</h2>
            <p>Book deliveries, review quotations and follow every shipment to your store.</p>
            <span class="portalgo">Open store portal →</span>
          </a>
          <a class="portalcard driver" href="/driver">
            <span class="portalicon">${icon('truck')}</span>
            <span class="eyebrow">DRIVER</span>
            <h2>Accept and drive.</h2>
            <p>See direct offers, manage your assigned jobs and record delivery proof.</p>
            <span class="portalgo">Open driver portal →</span>
          </a>
          <a class="portalcard broker" href="/broker">
            <span class="portalicon">${icon('grid')}</span>
            <span class="eyebrow">BROKER OPERATIONS</span>
            <h2>Quote and dispatch.</h2>
            <p>Price work, assign approved drivers and resolve exceptions from one desk.</p>
            <span class="portalgo">Open broker portal →</span>
          </a>
        </div>
        <p class="portalnote">Broker accounts are created by the YYC administrator. Store owners and drivers can register in their own portal.</p>
      </main>
    </div>`;
  }

  function decorateAuth(cfg) {
    document.body.dataset.role = portal;
    document.title = cfg.title;
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
    if (header) header.innerHTML = `<a class="textbtn" href="/?switch=1">← All portals</a><span>${cfg.label}</span>`;
    const eyebrow = $('.authbox .eyebrow');
    if (eyebrow) eyebrow.textContent = `${cfg.label} · ${authFlow === 'login' ? (authMode === 'register' ? 'CREATE ACCOUNT' : 'SIGN IN') : 'ACCOUNT ACCESS'}`;
    if (authFlow === 'login') {
      const heading = $('.authbox > h1');
      if (heading) heading.textContent = authMode === 'register' ? `Create your ${portal} account.` : `Sign in to the ${portal === 'broker' ? 'broker desk' : portal + ' workspace'}.`;
      const intro = $('.authbox > p.muted');
      if (intro) intro.textContent = authMode === 'register'
        ? (portal === 'driver' ? 'Register your details and truck; broker approval is required.' : 'Create a store account to request and follow deliveries.')
        : portal === 'broker' ? 'Quote, dispatch and resolve exceptions from the operations desk.'
          : portal === 'store' ? 'Manage your delivery requests, quotations and receipts.'
            : 'See your offers, assigned jobs and delivery records.';
    }
    const notice = $('.authbox .notice');
    if (notice) notice.textContent = cfg.notice;
    if (!cfg.canRegister) {
      $('.authbox .switch')?.remove();
      const roles = $('.authbox .roles');
      if (roles) roles.remove();
      if (authMode === 'register') {
        authMode = 'login';
        auth();
        return;
      }
    } else {
      const roles = $('.authbox .roles');
      if (roles) {
        roles.classList.add('singlerole');
        roles.innerHTML = `<button type="button" class="role selected">${icon(roleIcon[rolePortal[portal]])}<b>${roleLabel[rolePortal[portal]]}</b><small>${portal === 'store' ? 'I need goods delivered' : 'I have a truck for deliveries'}</small></button>`;
      }
    }
  }

  const baseAuth = auth;
  auth = function () {
    if (portal === 'root') { chooser(); return; }
    const expected = rolePortal[portal];
    authRole = expected;
    if (portal === 'broker') authMode = 'login';
    baseAuth();
    decorateAuth(info[portal]);
  };

  const baseLogin = login;
  login = async function (e) {
    await baseLogin(e);
    if (!sessionUser) return;
    const expected = rolePortal[role];
    if (portal !== 'root' && expected !== portal) { location.replace(portalPath[expected] || '/'); return; }
    const home = homeFor(role);
    if (page !== home) { page = home; render(); }
  };

  const baseNav = nav;
  nav = function (p) {
    if (sessionUser && !(navs[role] || []).some(item => item[0] === p)) p = homeFor(role);
    return baseNav(p);
  };

  function decorateApp() {
    const key = rolePortal[role];
    document.body.dataset.role = key || '';
    const cfg = info[key];
    if (!cfg) return;
    document.title = cfg.title;
    document.querySelector('.rolepicker')?.remove();
    const row = document.querySelector('.main .top .row');
    if (row && !row.querySelector('.portalswitch')) {
      const link = document.createElement('a');
      link.className = 'portalswitch';
      link.href = '/?switch=1';
      link.innerHTML = `<b>${cfg.short}</b><span>Switch portal →</span>`;
      row.prepend(link);
    }
    const breadcrumb = document.querySelector('.main .top > .muted');
    if (breadcrumb) {
      const label = (navs[role] || []).find(item => item[0] === page)?.[2] || 'Workspace';
      breadcrumb.innerHTML = `${E(cfg.short)} &nbsp; / &nbsp; <b>${E(label)}</b>`;
    }
    const side = document.querySelector('.sidebottom');
    if (side) side.innerHTML = `<b>${cfg.short}</b><br>YYC Brokers portal<br><button class="textbtn" style="color:#d8c59e;padding:15px 0 0" onclick="logoutAccount()">Log out</button>`;
  }

  // Role-specific screens. These sit on top of the shared components so the
  // three portals stop showing the same generic delivery workspace.
  function storeShipmentsPage() {
    const list = own();
    const quotes = list.filter(s => s.status === 'Quote ready');
    const moving = list.filter(s => s.status === 'In transit');
    const done = list.filter(s => s.status === 'Delivered');
    return title('My deliveries', 'Every request your store has sent, from quotation to delivery.', '<button class="btn" onclick="nav(\'booking\')">＋ Request delivery</button>')
      + stats([
        ['All requests', 'Saved on the server', list.length, 'box'],
        ['Quotes to review', 'Waiting for your response', quotes.length, 'file'],
        ['In transit', 'Goods picked up', moving.length, 'truck'],
        ['Delivered', 'Evidence recorded', done.length, 'check']
      ])
      + `<section class="card"><div class="row between"><h2>Delivery history</h2><button class="textbtn" onclick="nav('tracking')">Track active deliveries →</button></div>${table(list)}</section>`
      + `<div class="notice">Only deliveries requested by your store appear here. Live truck position requires the driver to share location.</div>`;
  }

  function driverJobsPage() {
    const list = own();
    const active = list.filter(s => !['Delivered', 'Cancelled'].includes(s.status));
    const done = list.filter(s => s.status === 'Delivered');
    const offers = shipments.filter(s => s.status === 'Offered' && s.offeredTo === sessionUser.id);
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
    return title('Delivery board', 'Search, filter and open every request in the brokerage.', '<button class="btn light" onclick="nav(\'dispatch\')">Back to dispatch</button>')
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
    return title('Dispatch schedule', 'Every delivery grouped by the next operational state.')
      + `<div class="schedulegrid" style="grid-template-columns:repeat(2,1fr)">${groups.map(([name, states]) => {
        const list = jobs.filter(s => states.includes(s.status));
        return `<section class="schedulecolumn"><div class="row between"><h3>${name}</h3><span class="tag gray">${list.length}</span></div>${list.length ? list.map(s => `<button class="schedulejob" onclick="openDelivery('${E(s.id)}')"><div class="row between">${badge(s.status)}<time>${E(s.date || 'No date')}</time></div><b>${E(s.id)} · ${E(s.customer)}</b><p>${E(s.pickup)}<br>→ ${E(s.destination)}<br>${E(s.window || 'Flexible')} · ${s.pallets} pallets · ${s.kg} kg</p><div class="row between" style="margin-top:13px;font-size:10px"><span>${s.driverName ? E(s.driverName) : 'Driver not assigned'}</span><span style="color:#537448">Open →</span></div></button>`).join('') : '<div class="emptylane">Nothing in this state.</div>'}</section>`;
      }).join('')}</div>`;
  }

  const baseContent = content;
  content = function () {
    if (role === 'admin') {
      if (page === 'dispatch' || page === 'dashboard') return realDispatch();
      if (page === 'shipments') return brokerShipmentsPage();
      if (page === 'schedule') return brokerSchedulePage();
      if (page === 'alerts') return realAlerts();
      if (page === 'exceptions') return exceptionQueue();
      if (page === 'reports') return operationsReport();
    }
    if (role === 'store' && page === 'shipments') return storeShipmentsPage();
    if (role === 'driver' && page === 'shipments') return driverJobsPage();
    return baseContent();
  };

  const baseRender = render;
  render = function () {
    if (sessionUser) {
      const expected = rolePortal[role];
      if (portal === 'root') {
        if (!switching && expected) { location.replace(portalPath[expected]); return; }
        chooser();
        return;
      }
      if (expected !== portal) { location.replace(portalPath[expected] || '/'); return; }
    } else if (portal === 'root') {
      chooser();
      return;
    }
    baseRender();
    if (sessionUser) decorateApp();
  };

  // Re-render once our overrides are in place. runtime.js starts boot() while
  // parsing, so this also covers the case where the session arrived first.
  if (portal === 'root') {
    if (sessionUser && !switching) location.replace(portalPath[rolePortal[role]] || '/');
    else chooser();
  } else if (page === 'auth') {
    auth();
  } else if (sessionUser) {
    if (rolePortal[role] !== portal) location.replace(portalPath[rolePortal[role]] || '/');
    else render();
  }
})();
