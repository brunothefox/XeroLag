'use strict';

(() => {
  const node = id => document.getElementById(id);
  let state = null;
  let active = false;
  let working = false;
  let loading = null;

  function make(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.setAttribute('aria-hidden', 'true');
    svg.append(use);
    return svg;
  }
  function message(text, failed = false) {
    node('profile-message').textContent = text;
    node('profile-message').hidden = !text;
    node('profile-message').classList.toggle('notice-error', failed);
    node('profile-message').classList.toggle('notice-success', Boolean(text) && !failed);
    if (text && !active) window.XeroUI.navigate('profiles');
  }
  function table(headers, rows) {
    const result = make('table');
    const head = make('thead');
    const labels = make('tr');
    for (const label of headers) { const th = make('th', label); th.scope = 'col'; labels.append(th); }
    head.append(labels);
    const body = make('tbody');
    for (const values of rows) {
      const row = make('tr');
      for (const value of values) { const cell = make('td', value); cell.title = String(value); row.append(cell); }
      body.append(row);
    }
    result.append(head, body);
    return result;
  }
  function summary(rows) {
    node('snapshot-summary').replaceChildren(...rows.map(([label, value]) => {
      const row = make('div', undefined, 'detail-row');
      row.append(make('dt', label), make('dd', value));
      return row;
    }));
  }
  function availability() {
    for (const button of document.querySelectorAll('[data-apply-profile]')) {
      const profile = state?.profiles.find(profile => profile.id === button.dataset.applyProfile);
      button.disabled = working || !profile?.available || state?.activeProfile===profile?.id&&!state?.drifted;
      button.title = profile?.reason || (profile?.powerPlan ? profile.powerPlan + ' · automatic safety snapshot' : 'Reading profile settings');
      button.classList.toggle('profile-selected', state?.activeProfile === profile?.id && !state?.drifted);
    }
    const canRevert = Boolean(state?.canRevert);
    for (const button of document.querySelectorAll('[data-revert-profiles]')) button.disabled = working || !canRevert;
    node('create-snapshot').disabled = working || !state || Boolean(state.blocked);
    node('open-backups').disabled = !state?.backup;
    node('recovery-setup-start').disabled=working||!state||Boolean(state.blocked&&!state.recovery);
  }
  function render() {
    if (!state) return;
    const applied = state.profiles.find(profile => profile.id === state.activeProfile);
    node('profile-active').textContent = state.recovery ? 'Recovery required' : state.drifted ? 'Settings changed externally' : applied?.name || 'Original settings';
    node('profile-active').dataset.warning = String(state.recovery || state.drifted);
    node('profile-list').setAttribute('aria-busy', 'false');
    node('profile-list').replaceChildren(...state.profiles.map(profile => {
      const row = make('div', undefined, 'profile-row');
      row.dataset.active=String(state.activeProfile===profile.id&&!state.drifted);
      const symbol = make('div', undefined, 'profile-symbol');
      symbol.append(icon(({gaming:'game',competitive:'bolt',quiet:'monitor'})[profile.id]||profile.icon));
      const copy = make('div', undefined, 'profile-copy');
      copy.append(make('h3', profile.name));
      const description = !profile.powerPlan ? profile.reason : profile.powerPlan + (profile.id === 'quiet' ? ' · Game Mode off' : ' · Game Mode on') +
        (profile.id === 'competitive' ? ' · mouse acceleration off · fast key repeat' : '');
      copy.append(make('p', description, 'profile-description'));
      if (profile.changes.length) {
        const changes = make('details', undefined, 'profile-changes');
        changes.append(make('summary', 'View changes'));
        const container = make('div', undefined, 'table-container');
        container.append(table(['Setting', 'Current', 'Profile'], profile.changes.map(change => [change.label, change.before, change.after])));
        changes.append(container);
        copy.append(changes);
      }
      const button = make('button', state.activeProfile === profile.id && !state.drifted ? 'Active' : 'Apply', 'button-primary');
      button.dataset.applyProfile = profile.id;
      button.setAttribute('aria-label', 'Apply ' + profile.name);
      button.addEventListener('click', () => { void perform('apply', profile.id); });
      row.append(symbol, copy, button);
      return row;
    }));
    const backup = state.backup;
    const revert=node('profile-status-strip').querySelector('[data-revert-profiles]');const safety=node('profile-safety-status');safety.className='sr-only';
    const recovery=make('button','Recovery','button-secondary');recovery.addEventListener('click',()=>window.XeroUI.navigate('recovery'));
    const strip=window.XeroUI.summary([{label:'Active profile',value:state.recovery?'Recovery required':state.drifted?'Changed externally':applied?.name||'Original settings',icon:'game',detail:state.currentPlan},{label:'Recovery snapshot',value:backup?.restorePoint?'#'+backup.restorePoint.sequence:'Not created',icon:'shield',detail:backup?.restorePoint?new Date(backup.restorePoint.createdAt).toLocaleString():null}],[recovery,revert]);strip.append(safety);node('profile-status-strip').replaceChildren(strip);
    const choose=make('button','Gaming profiles','button-secondary');choose.addEventListener('click',()=>window.XeroUI.navigate('profiles'));node('overview-profile-summary').replaceChildren(window.XeroUI.summary([{label:'Current profile',value:applied?.name||'Original settings',icon:'game'},{label:'Power plan',value:state.currentPlan,icon:'power'}],[choose]));
    node('gaming-shortcuts').replaceChildren();const links=make('div',undefined,'tool-shortcuts');for(const[label,iconName,page]of[['Game library','game','games'],['Process manager','activity','processes'],['Startup manager','power','startup'],['Recovery','shield','recovery']]){const control=make('button',label,'tool-shortcut');control.prepend(icon(iconName));control.addEventListener('click',()=>window.XeroUI.navigate(page));links.append(control);}node('gaming-shortcuts').append(links);
    node('recovery-setup').hidden=Boolean(backup?.restorePoint&&backup.phase!=='reverted'&&!state.recovery&&!state.blocked);
    node('recovery-setup-title').textContent=state.recovery?'An interrupted change needs recovery':state.blocked?'Recovery setup unavailable':backup&&!backup.restorePoint?'Finish recovery setup':'Set up recovery';
    node('recovery-setup-description').textContent=state.recovery?'Open Recovery to restore the saved settings.':state.blocked||'Save your current settings and create a Windows restore point.';
    node('recovery-setup-start').textContent=state.recovery?'Open recovery':'Create snapshot';
    node('profile-safety-status').textContent = !backup ? 'Automatic snapshot before first apply' : backup.phase === 'reverted' ? 'Original backup retained' :
      backup.restorePoint ? 'Backup saved · restore point #' + backup.restorePoint.sequence : 'JSON saved · restore point pending';
    node('snapshot-status').textContent = !backup ? 'Not created' : backup.phase === 'reverted' ? 'Restored' : backup.restorePoint ? 'Backup saved' : 'JSON saved · restore point pending';
    if (backup) {
      summary([
        ['Created', new Date(backup.createdAt).toLocaleString()],
        ['Original plan', backup.originalPlan],
        ['Registry values', String(backup.settings.length)],
        ['Restore point', backup.restorePoint ? '#' + backup.restorePoint.sequence + ' · ' + new Date(backup.restorePoint.createdAt).toLocaleString() : 'Not created']
      ]);
      node('snapshot-values').replaceChildren(table(['Setting', 'Original', 'Current', 'Type'], backup.settings.map(setting => [setting.label, setting.original, setting.current, setting.kind])));
      node('snapshot-file').textContent = backup.file;
    } else summary([['Backup', 'Created automatically before your first profile change'], ['Contents', 'Original registry values and active power plan']]);
    node('snapshot-details').hidden = !backup;
    node('create-snapshot').querySelector('span').textContent = backup && backup.phase !== 'reverted' ? 'Check restore point' : 'Create snapshot';
    if (active) node('power-plan').textContent = state.currentPlan;
    if (state.recovery) message('An operation was interrupted. Revert all to restore the original settings.', true);
    else if (state.blocked && active && !node('profile-message').textContent) message(state.blocked, true);
    availability();
  }
  async function refresh() {
    if (working) return;
    if (loading) return loading;
    loading = window.xerolag.profiles.getStatus().then(value => { state = value; render(); })
      .catch(error => { message(error.message, true); availability(); })
      .finally(() => { loading = null; });
    return loading;
  }
  async function perform(action, profileId) {
    if (working) return;
    working = true;
    message('');
    node('profile-progress').hidden = false;
    node('profile-progress-text').textContent = action === 'revert' ? 'Restoring saved settings…' : action === 'snapshot' ? 'Saving backup and creating a restore point…' : 'Saving backup and applying profile…';
    if (!active) document.querySelector('.nav-item[data-page="profiles"]').click();
    availability();
    try {
      state = await (action === 'revert' ? window.xerolag.profiles.revertAll() : action === 'snapshot' ? window.xerolag.profiles.createSnapshot() : window.xerolag.profiles.apply(profileId));
      render();
      message(action === 'revert' ? 'Original settings restored.' : action === 'snapshot' ? 'Safety snapshot ready.' : 'Profile applied.');
      document.dispatchEvent(new Event('xerolag:profiles-updated'));
    } catch (error) {
      message(error.message, true);
      try { state = await window.xerolag.profiles.getStatus(); render(); } catch { /* Keep the actionable operation error visible. */ }
    } finally {
      working = false;
      node('profile-progress').hidden = true;
      availability();
    }
  }
  document.addEventListener('xerolag:navigate', event => {
    active = event.detail === 'profiles';
    if (active) { if (state) render(); void refresh(); }
  });
  document.addEventListener('xerolag:refresh-profiles', () => { void refresh(); });
  for (const button of document.querySelectorAll('[data-apply-profile]')) button.addEventListener('click', () => { void perform('apply', button.dataset.applyProfile); });
  for (const button of document.querySelectorAll('[data-revert-profiles]')) button.addEventListener('click', () => { void perform('revert'); });
  node('create-snapshot').addEventListener('click', () => { void perform('snapshot'); });
  node('recovery-setup-start').addEventListener('click',()=>{
    if(state?.recovery){document.querySelector('.overview-action[data-page="recovery"]').click();return;}
    node('snapshot-fold').open=true;
    void perform('snapshot');
  });
  node('open-backups').addEventListener('click', () => { window.xerolag.profiles.openBackups().catch(error => message(error.message, true)); });
  node('open-protection').addEventListener('click', () => { window.xerolag.profiles.openSystemProtection().catch(error => message(error.message, true)); });
  void refresh();
})();
