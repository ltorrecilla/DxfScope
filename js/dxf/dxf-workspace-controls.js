// Native opening-screen controls. The host supplies navigation/transfer actions;
// this document owns their markup, styles and focus, like PDFScope's setup step.
window.DxfWorkspaceControls = {
    install({ mode, select, transfer, document = window.document }) {
        const labels = {
            es: ['Selector de herramienta', '¿Usar el dibujo actual del Editor como versión A, incluidos los cambios confirmados sin guardar?', 'Reemplazar A con el dibujo del Editor. La versión B se conserva.', 'Usar dibujo del Editor como A', 'Actualizar A desde el Editor', 'Ahora no', 'Los cambios del Editor no se sincronizan automáticamente.', 'Puedes usar el dibujo del Editor como A cuando quieras.'],
            fr: ['Sélecteur d’outil', 'Utiliser le dessin de l’Éditeur comme version A, avec les modifications validées non enregistrées ?', 'Remplacer A par le dessin de l’Éditeur. La version B est conservée.', 'Utiliser le dessin comme A', 'Actualiser A depuis l’Éditeur', 'Pas maintenant', 'Les modifications de l’Éditeur ne sont pas synchronisées automatiquement.', 'Vous pourrez utiliser le dessin de l’Éditeur comme A plus tard.'],
            de: ['Werkzeugauswahl', 'Die aktuelle Editor-Zeichnung einschließlich bestätigter ungespeicherter Änderungen als Version A verwenden?', 'A durch die Editor-Zeichnung ersetzen. Version B bleibt erhalten.', 'Editor-Zeichnung als A verwenden', 'A aus dem Editor aktualisieren', 'Nicht jetzt', 'Editor-Änderungen werden nicht automatisch synchronisiert.', 'Sie können die Editor-Zeichnung später als A verwenden.'],
            it: ['Selettore strumento', 'Usare il disegno dell’Editor come versione A, incluse le modifiche confermate non salvate?', 'Sostituire A con il disegno dell’Editor. La versione B viene mantenuta.', 'Usa il disegno come A', 'Aggiorna A dall’Editor', 'Non ora', 'Le modifiche dell’Editor non vengono sincronizzate automaticamente.', 'Puoi usare il disegno dell’Editor come A più tardi.'],
            pt: ['Seletor de ferramenta', 'Usar o desenho atual do Editor como versão A, incluindo alterações confirmadas não guardadas?', 'Substituir A pelo desenho do Editor. A versão B é mantida.', 'Usar desenho do Editor como A', 'Atualizar A a partir do Editor', 'Agora não', 'As alterações do Editor não são sincronizadas automaticamente.', 'Pode usar o desenho do Editor como A mais tarde.'],
            zh: ['工具选择', '将编辑器中的当前图纸用作版本 A，包括已确认但尚未保存的编辑？', '使用编辑器图纸替换版本 A。版本 B 保持不变。', '使用编辑器图纸作为 A', '从编辑器更新 A', '暂不使用', '编辑器中的更改不会自动同步。', '您可以稍后将编辑器图纸用作 A。'],
            ja: ['ツール選択', '確定済みの未保存の編集を含む現在の図面をバージョン A として使用しますか？', 'A をエディターの図面で置き換えます。バージョン B は保持されます。', '図面を A として使用', 'エディターから A を更新', '今はしない', 'エディターの変更は自動的に同期されません。', '後でエディターの図面を A として使用できます。'],
            ko: ['도구 선택', '확정했지만 저장하지 않은 편집을 포함하여 현재 도면을 버전 A로 사용하시겠습니까?', 'A를 편집기의 도면으로 바꿉니다. 버전 B는 유지됩니다.', '편집기 도면을 A로 사용', '편집기에서 A 업데이트', '나중에', '편집기의 변경 사항은 자동으로 동기화되지 않습니다.', '나중에 편집기 도면을 A로 사용할 수 있습니다.'],
        };
        const mount = document.querySelector('[data-dxf-tool-selector]');
        const section = document.createElement('section');
        section.className = 'dxf-tool-selector';
        section.innerHTML = `<h2><span class="dxf-tool-icon"><i data-lucide="file-code"></i></span><span></span></h2><div class="dxf-tool-modes" role="group" aria-label="Drawing mode">
            <button type="button" data-workspace-mode="editor"></button>
            <button type="button" data-workspace-mode="compare"></button></div>
            <div class="dxf-snapshot-offer" hidden><p class="dxf-snapshot-description"></p>
            <button type="button" class="dxf-snapshot-transfer"></button>
            <button type="button" class="dxf-snapshot-dismiss"></button><p class="dxf-snapshot-stamp"></p></div>`;
        mount.append(section);
        window.lucide?.createIcons({ root: section });
        const buttons = [...section.querySelectorAll('[data-workspace-mode]')];
        buttons.forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.workspaceMode === mode));
            button.addEventListener('click', () => select(button.dataset.workspaceMode));
            button.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                (event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons[1] : buttons.find(b => b !== button)).focus();
            });
        });
        const offer = section.querySelector('.dxf-snapshot-offer');
        const action = section.querySelector('.dxf-snapshot-transfer');
        const dismiss = section.querySelector('.dxf-snapshot-dismiss');
        let dismissed = false, state = { available: false, empty: true, stamp: null };
        function render() {
            const text = ["workspaceToolSelector","workspaceUseDrawingQuestion","workspaceReplaceDrawing","workspaceUseDrawing","workspaceRefreshDrawing","workspaceNotNow","workspaceNotSynced","workspaceDrawingReady"].map((key, i) => window.PAGE_I18N?.[key] || labels[document.documentElement.lang]?.[i] || window.CADSCOPE_EN[key]);
            for (const button of buttons) { const key = button.dataset.workspaceMode === 'editor' ? 'workspaceEditor' : 'workspaceCompare'; button.textContent = window.PAGE_I18N?.[key] || window.CADSCOPE_EN[key]; }
            section.querySelector('h2 > span:last-child').textContent = text[0];
            section.querySelector('[role="group"]').setAttribute('aria-label', text[0]);
            offer.hidden = mode !== 'compare' || !state.available;
            section.querySelector('.dxf-snapshot-description').textContent = state.empty ? text[dismissed ? 7 : 1] : text[2];
            action.textContent = text[state.empty ? 3 : 4];
            dismiss.textContent = text[5]; dismiss.hidden = !state.empty || dismissed;
            section.querySelector('.dxf-snapshot-stamp').textContent = state.stamp
                ? new Date(state.stamp).toLocaleString(document.documentElement.lang || 'en') + ' — ' + text[6] : '';
        }
        action.addEventListener('click', transfer);
        dismiss.addEventListener('click', () => { dismissed = true; render(); });
        document.addEventListener('languageLoaded', render);
        render();
        return {
            busy(value) { [...buttons, action, dismiss].forEach(button => { button.disabled = value; }); },
            update(next) { state = next; render(); },
        };
    },
};
