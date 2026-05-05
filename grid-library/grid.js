/**
 * DataGrid - 순수 바닐라 JavaScript Grid 라이브러리
 *
 * 사용법:
 *   <link rel="stylesheet" href="grid.css">
 *   <script src="grid.js"></script>
 *
 *   const grid = new DataGrid({
 *     container: '#my-grid',
 *     columns: [
 *       { key: 'id',   title: 'ID',   width: 80,  sortable: true, pinned: true },
 *       { key: 'name', title: '이름', width: 200, editable: true, filterable: true },
 *       { key: 'age',  title: '나이', width: 80,  type: 'number' },
 *     ],
 *     data: [...],
 *     options: { pageSize: 20, selectable: 'multiple', theme: 'light' }
 *   });
 *
 *   grid.on('rowSelect', rows => console.log(rows));
 *   grid.on('cellEdit',  info  => console.log(info));
 */
class DataGrid {
  // ==================== 기본 설정값 ====================

  static defaults = {
    columns: [],
    data: [],
    options: {
      pageSize: 20,
      selectable: 'multiple', // none | single | multiple
      resizable: true,        // 컬럼 폭 조절 허용
      theme: 'light',         // light | dark
      maxHeight: 500,         // tbody 최대 높이 (px)
      emptyMessage: '데이터가 없습니다.',
      exportFilename: 'export',
    },
  };

  // ==================== 생성자 ====================

  constructor(config) {
    // 전달받은 설정과 기본값을 병합
    this._config = {
      ...DataGrid.defaults,
      ...config,
      options: { ...DataGrid.defaults.options, ...(config.options || {}) },
    };

    // 내부 상태 초기화
    this._state = {
      originalData: [],    // 원본 데이터 (_rowId 포함)
      filteredData: [],    // 필터·정렬이 적용된 데이터
      displayData: [],     // 현재 페이지에 표시되는 데이터

      sortColumns: [],     // [{ key, dir: 'asc'|'desc' }]  멀티 정렬
      columnFilters: {},   // { [colKey]: filterValue }
      globalSearch: '',

      currentPage: 1,
      pageSize: this._config.options.pageSize,

      selectedRows: new Set(),       // 선택된 행의 _rowId 집합
      lastSelectedRowId: null,       // Shift+클릭 범위 선택 기준

      columnWidths: {},              // { [colKey]: px }
      hiddenColumns: new Set(),      // 숨겨진 컬럼 key

      isLoading: false,
      editingCell: null,             // { rowId, colKey }
      pinnedOffsets: {},             // { [colKey]: leftPx }
    };

    // DOM 참조 캐시
    this._elements = {};

    // 이벤트 핸들러 저장소 (on/off/emit)
    this._eventListeners = {};

    // 드래그 관련 임시 상태
    this._dragState = null;

    // document에 바인딩한 핸들러를 destroy 시 제거하기 위해 저장
    this._boundHandlers = {
      onResizeMove: this._onResizeMove.bind(this),
      onResizeEnd:  this._onResizeEnd.bind(this),
      onKeyDown:    this._handleKeyDown.bind(this),
    };

    this._init();
  }

  // ==================== 초기화 ====================

  _init() {
    // 컨테이너 DOM 찾기
    const container =
      typeof this._config.container === 'string'
        ? document.querySelector(this._config.container)
        : this._config.container;

    if (!container) {
      throw new Error(`DataGrid: 컨테이너를 찾을 수 없습니다 — "${this._config.container}"`);
    }

    this._elements.container = container;
    container.innerHTML = '';

    // 컬럼 기본값 설정
    this._resolveConfig();

    // HTML 뼈대 1회 생성
    this._buildSkeleton();

    // 전역 키보드 이벤트 바인딩
    document.addEventListener('keydown', this._boundHandlers.onKeyDown);

    // 초기 데이터가 있으면 로드
    if (this._config.data && this._config.data.length > 0) {
      this.setData(this._config.data);
    } else {
      this._render();
    }
  }

  _resolveConfig() {
    // 각 컬럼에 누락된 기본값 채우기
    this._config.columns = this._config.columns.map(col => ({
      width: 120,
      sortable: true,
      filterable: false,
      editable: false,
      pinned: false,
      type: 'text', // text | number | date | boolean
      align: col.type === 'number' ? 'right' : 'left',
      ...col,
    }));

    // 초기 컬럼 폭 상태에 저장
    this._config.columns.forEach(col => {
      this._state.columnWidths[col.key] = col.width;
    });
  }

  _buildSkeleton() {
    const { theme, maxHeight } = this._config.options;

    // ── 최상위 래퍼 ──
    const wrapper = document.createElement('div');
    wrapper.className = 'dg-wrapper';
    wrapper.setAttribute('data-theme', theme);
    wrapper.style.setProperty('--dg-max-height', maxHeight + 'px');
    this._elements.wrapper = wrapper;

    // ── 툴바 ──
    const toolbar = document.createElement('div');
    toolbar.className = 'dg-toolbar';
    this._elements.toolbar = toolbar;
    this._renderToolbar();

    // ── 테이블 래퍼 (오버레이 기준점) ──
    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'dg-table-wrapper';

    // ── 스크롤 컨테이너 ──
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'dg-scroll-container';
    this._elements.scrollContainer = scrollContainer;

    // ── 테이블 ──
    const table = document.createElement('table');
    table.className = 'dg-table';
    this._elements.table = table;

    // ── colgroup: 컬럼 폭 제어의 핵심 ──
    const colgroup = document.createElement('colgroup');
    this._elements.colgroup = colgroup;
    this._rebuildColgroup();

    // ── thead / tbody ──
    const thead = document.createElement('thead');
    thead.className = 'dg-thead';
    this._elements.thead = thead;

    const tbody = document.createElement('tbody');
    tbody.className = 'dg-tbody';
    this._elements.tbody = tbody;
    this._bindTableEvents(); // 이벤트 위임 바인딩

    table.appendChild(colgroup);
    table.appendChild(thead);
    table.appendChild(tbody);
    scrollContainer.appendChild(table);

    // ── 로딩 오버레이 ──
    const loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'dg-overlay dg-loading';
    loadingOverlay.innerHTML = '<div class="dg-spinner"></div><span>불러오는 중...</span>';
    loadingOverlay.style.display = 'none';
    this._elements.loadingOverlay = loadingOverlay;

    // ── 빈 상태 오버레이 ──
    const emptyOverlay = document.createElement('div');
    emptyOverlay.className = 'dg-overlay dg-empty';
    emptyOverlay.textContent = this._config.options.emptyMessage;
    emptyOverlay.style.display = 'none';
    this._elements.emptyOverlay = emptyOverlay;

    tableWrapper.appendChild(scrollContainer);
    tableWrapper.appendChild(loadingOverlay);
    tableWrapper.appendChild(emptyOverlay);

    // ── 페이지네이션 ──
    const pagination = document.createElement('div');
    pagination.className = 'dg-pagination';
    this._elements.pagination = pagination;

    // ── 최종 조립 ──
    wrapper.appendChild(toolbar);
    wrapper.appendChild(tableWrapper);
    wrapper.appendChild(pagination);
    this._elements.container.appendChild(wrapper);
  }

  // colgroup의 col 요소를 현재 컬럼 상태에 맞게 재생성
  _rebuildColgroup() {
    const colgroup = this._elements.colgroup;
    colgroup.innerHTML = '';

    // 체크박스 컬럼 col
    if (this._config.options.selectable !== 'none') {
      const col = document.createElement('col');
      col.style.width = '44px';
      colgroup.appendChild(col);
    }

    // 드래그 핸들 컬럼 col
    const dragCol = document.createElement('col');
    dragCol.style.width = '32px';
    colgroup.appendChild(dragCol);

    // 데이터 컬럼 col
    this._config.columns.forEach(col => {
      if (this._state.hiddenColumns.has(col.key)) return;
      const colEl = document.createElement('col');
      colEl.dataset.key = col.key;
      colEl.style.width = (this._state.columnWidths[col.key] || col.width) + 'px';
      colgroup.appendChild(colEl);
    });
  }

  // ==================== 툴바 렌더링 ====================

  _renderToolbar() {
    const toolbar = this._elements.toolbar;
    toolbar.innerHTML = '';

    // 왼쪽: 검색창
    const left = document.createElement('div');
    left.className = 'dg-toolbar-left';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'dg-search';
    searchInput.placeholder = '검색...';
    searchInput.value = this._state.globalSearch;
    searchInput.addEventListener('input', e => this._handleGlobalSearch(e.target.value));
    this._elements.searchInput = searchInput;
    left.appendChild(searchInput);

    // 오른쪽: 컬럼 설정, 테마, CSV 버튼
    const right = document.createElement('div');
    right.className = 'dg-toolbar-right';

    // 컬럼 표시/숨기기 버튼 + 패널
    const colToggleBtn = document.createElement('button');
    colToggleBtn.className = 'dg-btn dg-col-toggle-btn';
    colToggleBtn.innerHTML = '<span class="dg-icon">☰</span> 컬럼';
    colToggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      this._toggleColPanel();
    });

    const colPanel = document.createElement('div');
    colPanel.className = 'dg-col-panel';
    colPanel.style.display = 'none';
    this._elements.colPanel = colPanel;
    this._renderColPanel();

    right.appendChild(colToggleBtn);
    right.appendChild(colPanel);

    // 테마 전환 버튼
    const themeBtn = document.createElement('button');
    themeBtn.className = 'dg-btn';
    themeBtn.innerHTML = '<span class="dg-icon">◑</span> 테마';
    themeBtn.addEventListener('click', () => this._toggleTheme());
    right.appendChild(themeBtn);

    // CSV 내보내기 버튼
    const exportBtn = document.createElement('button');
    exportBtn.className = 'dg-btn';
    exportBtn.innerHTML = '<span class="dg-icon">↓</span> CSV';
    exportBtn.addEventListener('click', () => this.exportCSV());
    right.appendChild(exportBtn);

    toolbar.appendChild(left);
    toolbar.appendChild(right);

    // 패널 외부 클릭 시 닫기
    document.addEventListener('click', () => {
      if (this._elements.colPanel) this._elements.colPanel.style.display = 'none';
    });
  }

  _renderColPanel() {
    const panel = this._elements.colPanel;
    panel.innerHTML = '<div class="dg-col-panel-title">컬럼 설정</div>';

    this._config.columns.forEach(col => {
      const item = document.createElement('label');
      item.className = 'dg-col-panel-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !this._state.hiddenColumns.has(col.key);
      checkbox.addEventListener('change', e => {
        e.target.checked ? this.showColumn(col.key) : this.hideColumn(col.key);
        this._renderColPanel(); // 패널 상태 동기화
      });

      item.appendChild(checkbox);
      item.appendChild(document.createTextNode(' ' + col.title));
      panel.appendChild(item);
    });
  }

  _toggleColPanel() {
    const panel = this._elements.colPanel;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }

  _toggleTheme() {
    const wrapper = this._elements.wrapper;
    const current = wrapper.getAttribute('data-theme');
    wrapper.setAttribute('data-theme', current === 'light' ? 'dark' : 'light');
  }

  // ==================== 행 ID 부여 ====================

  _assignRowIds(data) {
    // 원본 데이터를 shallow copy하여 _rowId 추가 (원본 객체 불변)
    return data.map((row, i) => ({ ...row, _rowId: String(i) }));
  }

  // ==================== pinned 컬럼 오프셋 계산 ====================

  _computePinnedOffsets() {
    const hasCheckbox = this._config.options.selectable !== 'none';
    const baseOffset = (hasCheckbox ? 44 : 0) + 32; // 체크박스 + 드래그 핸들

    let offset = 0;
    this._state.pinnedOffsets = {};

    this._config.columns.forEach(col => {
      if (col.pinned && !this._state.hiddenColumns.has(col.key)) {
        this._state.pinnedOffsets[col.key] = baseOffset + offset;
        offset += this._state.columnWidths[col.key] || col.width;
      }
    });
  }

  // ==================== 렌더링 파이프라인 ====================

  _render() {
    this._rebuildColgroup();
    this._computePinnedOffsets();
    this._renderHeader();
    this._renderRows();
    this._renderPagination();
  }

  // ==================== 헤더 렌더링 ====================

  _renderHeader() {
    const thead = this._elements.thead;
    thead.innerHTML = '';

    // ── 메인 헤더 행 ──
    const headerRow = document.createElement('tr');
    headerRow.className = 'dg-header-row';

    // 체크박스 헤더 셀
    if (this._config.options.selectable !== 'none') {
      const th = document.createElement('th');
      th.className = 'dg-th dg-th-checkbox';

      if (this._config.options.selectable === 'multiple') {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'dg-checkbox';
        checkbox.title = '전체 선택';
        checkbox.addEventListener('change', e => this._handleSelectAll(e.target.checked));
        this._elements.selectAllCheckbox = checkbox;
        th.appendChild(checkbox);
      }
      headerRow.appendChild(th);
    }

    // 드래그 핸들 헤더 셀
    const dragTh = document.createElement('th');
    dragTh.className = 'dg-th dg-th-drag';
    dragTh.title = '행 드래그로 순서 변경';
    dragTh.textContent = '⠿';
    headerRow.appendChild(dragTh);

    // 데이터 컬럼 헤더 셀
    this._config.columns.forEach(col => {
      if (this._state.hiddenColumns.has(col.key)) return;

      const th = document.createElement('th');
      th.className = 'dg-th' + (col.pinned ? ' dg-th--pinned' : '');
      th.style.textAlign = col.align || 'left';

      if (col.pinned) {
        th.style.left = this._state.pinnedOffsets[col.key] + 'px';
      }

      const inner = document.createElement('div');
      inner.className = 'dg-th-inner';

      // 컬럼 제목
      const title = document.createElement('span');
      title.className = 'dg-th-title';
      title.textContent = col.title;
      inner.appendChild(title);

      // 정렬 아이콘 + 클릭 이벤트
      if (col.sortable !== false) {
        const sortIcon = document.createElement('span');
        sortIcon.className = 'dg-sort-icon';
        sortIcon.innerHTML = this._getSortIcon(col.key);
        inner.appendChild(sortIcon);

        th.addEventListener('click', e => {
          if (e.target.closest('.dg-resize-handle')) return; // 리사이즈 핸들은 무시
          this._handleHeaderClick(e, col.key);
        });
        th.style.cursor = 'pointer';
        th.title = 'Shift+클릭: 멀티 정렬';
      }

      // 리사이즈 핸들
      if (this._config.options.resizable) {
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'dg-resize-handle';
        resizeHandle.addEventListener('pointerdown', e => this._onResizeStart(e, col.key));
        inner.appendChild(resizeHandle);
      }

      th.appendChild(inner);
      headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);

    // ── 컬럼별 필터 행 ──
    const hasFilter = this._config.columns.some(col => col.filterable && !this._state.hiddenColumns.has(col.key));
    if (hasFilter) {
      const filterRow = document.createElement('tr');
      filterRow.className = 'dg-filter-row';

      if (this._config.options.selectable !== 'none') {
        filterRow.appendChild(document.createElement('th'));
      }
      filterRow.appendChild(document.createElement('th')); // 드래그 핸들 자리

      this._config.columns.forEach(col => {
        if (this._state.hiddenColumns.has(col.key)) return;

        const th = document.createElement('th');
        th.className = 'dg-filter-th';

        if (col.filterable) {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'dg-col-filter';
          input.placeholder = `${col.title} 필터...`;
          input.value = this._state.columnFilters[col.key] || '';
          input.addEventListener('input', e => this._handleFilterInput(col.key, e.target.value));
          th.appendChild(input);
        }

        filterRow.appendChild(th);
      });

      thead.appendChild(filterRow);
    }

    // 리사이즈 이벤트를 document에 등록 (move/up은 전역으로 처리해야 정확함)
    if (this._config.options.resizable) {
      document.removeEventListener('pointermove', this._boundHandlers.onResizeMove);
      document.removeEventListener('pointerup', this._boundHandlers.onResizeEnd);
      document.addEventListener('pointermove', this._boundHandlers.onResizeMove);
      document.addEventListener('pointerup', this._boundHandlers.onResizeEnd);
    }
  }

  // ==================== 행 렌더링 ====================

  _renderRows() {
    const tbody = this._elements.tbody;
    const data = this._state.displayData;

    // 빈 상태 오버레이 표시 여부
    this._elements.emptyOverlay.style.display =
      !this._state.isLoading && data.length === 0 ? 'flex' : 'none';

    if (data.length === 0) {
      tbody.innerHTML = '';
      return;
    }

    // innerHTML 한 번에 교체 (DOM 조각 생성보다 빠름)
    const rowsHtml = data.map((row, rowIndex) => {
      const isSelected = this._state.selectedRows.has(row._rowId);
      const isAlt = rowIndex % 2 === 1;

      let html = `<tr class="dg-row${isSelected ? ' dg-row--selected' : ''}${isAlt ? ' dg-row--alt' : ''}"
          data-row-id="${row._rowId}" draggable="true">`;

      // 체크박스 셀
      if (this._config.options.selectable !== 'none') {
        html += `<td class="dg-td dg-td-checkbox">
          <input type="checkbox" class="dg-checkbox dg-row-checkbox"
            data-row-id="${row._rowId}" ${isSelected ? 'checked' : ''}>
        </td>`;
      }

      // 드래그 핸들 셀
      html += `<td class="dg-td dg-td-drag">
        <span class="dg-drag-handle" title="드래그하여 순서 변경">⠿</span>
      </td>`;

      // 데이터 셀
      this._config.columns.forEach(col => {
        if (this._state.hiddenColumns.has(col.key)) return;

        const isPinned = col.pinned;
        const pinnedCss = isPinned
          ? `position:sticky;left:${this._state.pinnedOffsets[col.key]}px;z-index:1;`
          : '';
        const alignCss = `text-align:${col.align || 'left'};`;

        html += `<td class="dg-td${isPinned ? ' dg-td--pinned' : ''}${col.editable ? ' dg-td--editable' : ''}"
            data-col-key="${col.key}"
            style="${alignCss}${pinnedCss}">
          ${this._renderCell(row, col)}
        </td>`;
      });

      html += '</tr>';
      return html;
    }).join('');

    tbody.innerHTML = rowsHtml;

    // 드래그 핸들 이벤트 바인딩
    this._initRowDragHandlers();
  }

  _renderCell(row, col) {
    const value = row[col.key];

    // 커스텀 렌더러 우선
    if (col.render) return col.render(value, row);

    if (value === null || value === undefined) {
      return '<span class="dg-cell-empty">-</span>';
    }

    switch (col.type) {
      case 'boolean':
        return value
          ? '<span class="dg-badge dg-badge--green">✓ 예</span>'
          : '<span class="dg-badge dg-badge--red">✗ 아니오</span>';
      case 'number':
        return `<span>${Number(value).toLocaleString('ko-KR')}</span>`;
      case 'date':
        return `<span>${new Date(value).toLocaleDateString('ko-KR')}</span>`;
      default:
        return `<span>${this._escapeHtml(String(value))}</span>`;
    }
  }

  // ==================== 페이지네이션 렌더링 ====================

  _renderPagination() {
    const pagination = this._elements.pagination;
    const total = this._state.filteredData.length;
    const { pageSize, currentPage } = this._state;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const start = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const end = Math.min(currentPage * pageSize, total);

    pagination.innerHTML = '';

    // 왼쪽: 데이터 건수 정보
    const info = document.createElement('div');
    info.className = 'dg-page-info';
    info.textContent = `${start.toLocaleString()}-${end.toLocaleString()} / 전체 ${total.toLocaleString()}건`;
    pagination.appendChild(info);

    // 가운데: 페이지 이동 버튼
    const buttons = document.createElement('div');
    buttons.className = 'dg-page-buttons';

    const addBtn = (label, page, disabled, isActive = false) => {
      const btn = document.createElement('button');
      btn.className = 'dg-page-btn' + (isActive ? ' dg-page-btn--active' : '');
      btn.textContent = label;
      btn.disabled = disabled;
      if (!disabled) btn.addEventListener('click', () => this._goToPage(page));
      buttons.appendChild(btn);
    };

    addBtn('«', 1, currentPage === 1);
    addBtn('‹', currentPage - 1, currentPage === 1);

    // 페이지 번호 (최대 앞뒤 2페이지씩 표시)
    const range = 2;
    const startPage = Math.max(1, currentPage - range);
    const endPage = Math.min(totalPages, currentPage + range);

    if (startPage > 1) {
      addBtn('1', 1, false);
      if (startPage > 2) {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'dg-page-ellipsis';
        ellipsis.textContent = '···';
        buttons.appendChild(ellipsis);
      }
    }

    for (let p = startPage; p <= endPage; p++) {
      addBtn(String(p), p, p === currentPage, p === currentPage);
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'dg-page-ellipsis';
        ellipsis.textContent = '···';
        buttons.appendChild(ellipsis);
      }
      addBtn(String(totalPages), totalPages, false);
    }

    addBtn('›', currentPage + 1, currentPage === totalPages);
    addBtn('»', totalPages, currentPage === totalPages);

    pagination.appendChild(buttons);

    // 오른쪽: 페이지당 행 수 선택
    const right = document.createElement('div');
    right.className = 'dg-page-right';

    const label = document.createElement('span');
    label.className = 'dg-page-size-label';
    label.textContent = '페이지당 행 수:';

    const select = document.createElement('select');
    select.className = 'dg-page-size';
    [10, 20, 50, 100].forEach(size => {
      const option = document.createElement('option');
      option.value = size;
      option.textContent = size;
      option.selected = size === pageSize;
      select.appendChild(option);
    });
    select.addEventListener('change', e => this._changePageSize(Number(e.target.value)));

    right.appendChild(label);
    right.appendChild(select);
    pagination.appendChild(right);
  }

  // ==================== 데이터 처리 파이프라인 ====================

  _pipeline() {
    this._applyFilters();
    this._applySort();

    // 현재 페이지가 범위를 벗어나면 1페이지로
    const totalPages = Math.max(1, Math.ceil(this._state.filteredData.length / this._state.pageSize));
    if (this._state.currentPage > totalPages) this._state.currentPage = 1;

    this._applyPagination();
    this._render();
  }

  _applyFilters() {
    const { globalSearch, columnFilters } = this._state;

    this._state.filteredData = this._state.originalData.filter(row => {
      // 글로벌 검색: 하나라도 일치하면 통과
      if (globalSearch) {
        const lower = globalSearch.toLowerCase();
        const match = this._config.columns.some(col => {
          const v = row[col.key];
          return v !== null && v !== undefined && String(v).toLowerCase().includes(lower);
        });
        if (!match) return false;
      }

      // 컬럼별 필터: 모두 충족해야 통과
      for (const [key, filterVal] of Object.entries(columnFilters)) {
        if (!filterVal) continue;
        const v = row[key];
        if (v === null || v === undefined) return false;
        if (!String(v).toLowerCase().includes(filterVal.toLowerCase())) return false;
      }

      return true;
    });
  }

  _applySort() {
    const sortCols = this._state.sortColumns;
    if (sortCols.length === 0) return;

    this._state.filteredData.sort((a, b) => {
      for (const { key, dir } of sortCols) {
        const mult = dir === 'asc' ? 1 : -1;
        const aVal = a[key];
        const bVal = b[key];

        // null/undefined는 항상 맨 뒤
        if (aVal == null && bVal == null) continue;
        if (aVal == null) return 1;
        if (bVal == null) return -1;

        if (aVal < bVal) return -1 * mult;
        if (aVal > bVal) return 1 * mult;
      }
      return 0;
    });
  }

  _applyPagination() {
    const { currentPage, pageSize, filteredData } = this._state;
    const start = (currentPage - 1) * pageSize;
    this._state.displayData = filteredData.slice(start, start + pageSize);
  }

  // ==================== 정렬 ====================

  _handleHeaderClick(e, colKey) {
    this._toggleSort(colKey, e.shiftKey);
    this._pipeline();
    this._emit('sort', { sortColumns: [...this._state.sortColumns] });
  }

  _toggleSort(colKey, isMulti) {
    const existing = this._state.sortColumns.find(s => s.key === colKey);

    if (!isMulti) {
      // 단독 클릭: asc → desc → 초기화
      if (!existing) {
        this._state.sortColumns = [{ key: colKey, dir: 'asc' }];
      } else if (existing.dir === 'asc') {
        this._state.sortColumns = [{ key: colKey, dir: 'desc' }];
      } else {
        this._state.sortColumns = [];
      }
    } else {
      // Shift+클릭: 멀티 정렬 누적
      if (!existing) {
        this._state.sortColumns.push({ key: colKey, dir: 'asc' });
      } else if (existing.dir === 'asc') {
        existing.dir = 'desc';
      } else {
        this._state.sortColumns = this._state.sortColumns.filter(s => s.key !== colKey);
      }
    }
  }

  _getSortIcon(colKey) {
    const sort = this._state.sortColumns.find(s => s.key === colKey);
    if (!sort) return '<span class="dg-sort-none">↕</span>';
    return sort.dir === 'asc'
      ? '<span class="dg-sort-asc">↑</span>'
      : '<span class="dg-sort-desc">↓</span>';
  }

  // ==================== 필터 ====================

  _handleGlobalSearch(value) {
    this._state.globalSearch = value;
    this._state.currentPage = 1;
    this._pipeline();
    this._emit('filter', { filters: this._state.columnFilters, globalSearch: value });
  }

  _handleFilterInput(colKey, value) {
    this._state.columnFilters[colKey] = value;
    this._state.currentPage = 1;
    this._pipeline();
    this._emit('filter', { filters: this._state.columnFilters, globalSearch: this._state.globalSearch });
  }

  // ==================== 페이지네이션 ====================

  _goToPage(page) {
    const totalPages = Math.max(1, Math.ceil(this._state.filteredData.length / this._state.pageSize));
    this._state.currentPage = Math.max(1, Math.min(page, totalPages));
    this._applyPagination();
    this._render();
    this._emit('pageChange', { page: this._state.currentPage, pageSize: this._state.pageSize });
  }

  _changePageSize(size) {
    this._state.pageSize = size;
    this._state.currentPage = 1;
    this._applyPagination();
    this._render();
    this._emit('pageChange', { page: 1, pageSize: size });
  }

  // ==================== 행 선택 ====================

  _bindTableEvents() {
    const tbody = this._elements.tbody;

    // 클릭: 행 선택 (이벤트 위임)
    tbody.addEventListener('click', e => {
      if (e.target.closest('.dg-row-checkbox')) return; // 체크박스는 change 이벤트로 처리
      if (e.target.closest('.dg-drag-handle')) return;
      if (e.target.closest('.dg-cell-editor')) return;  // 편집 중엔 선택 무시

      const tr = e.target.closest('tr[data-row-id]');
      if (!tr) return;

      this._handleRowClick(e, tr.dataset.rowId);

      // rowClick 이벤트 발화
      const rowData = this._getRowById(tr.dataset.rowId);
      if (rowData) this._emit('rowClick', { row: this._stripRowId(rowData), event: e });
    });

    // 더블클릭: 인라인 편집
    tbody.addEventListener('dblclick', e => {
      const td = e.target.closest('td.dg-td--editable');
      if (!td) return;
      const tr = td.closest('tr[data-row-id]');
      this._handleCellDblClick(e, tr.dataset.rowId, td.dataset.colKey);
    });

    // 체크박스 변경
    tbody.addEventListener('change', e => {
      const checkbox = e.target.closest('.dg-row-checkbox');
      if (checkbox) this._handleCheckboxChange(checkbox.dataset.rowId, checkbox.checked);
    });
  }

  _handleRowClick(e, rowId) {
    const selectable = this._config.options.selectable;
    if (selectable === 'none') return;

    if (selectable === 'single') {
      this._state.selectedRows.clear();
      this._state.selectedRows.add(rowId);
    } else {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+클릭: 토글
        if (this._state.selectedRows.has(rowId)) {
          this._state.selectedRows.delete(rowId);
        } else {
          this._state.selectedRows.add(rowId);
        }
      } else if (e.shiftKey && this._state.lastSelectedRowId) {
        // Shift+클릭: 범위 선택
        this._selectRange(this._state.lastSelectedRowId, rowId);
      } else {
        this._state.selectedRows.clear();
        this._state.selectedRows.add(rowId);
      }
    }

    this._state.lastSelectedRowId = rowId;
    this._updateRowSelectionUI();
    this._emit('rowSelect', { selectedRows: this.getSelectedRows() });
  }

  _selectRange(fromId, toId) {
    const data = this._state.displayData;
    const fromIdx = data.findIndex(r => r._rowId === fromId);
    const toIdx = data.findIndex(r => r._rowId === toId);
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);

    for (let i = start; i <= end; i++) {
      this._state.selectedRows.add(data[i]._rowId);
    }
  }

  _handleCheckboxChange(rowId, checked) {
    checked ? this._state.selectedRows.add(rowId) : this._state.selectedRows.delete(rowId);
    this._updateRowSelectionUI();
    this._emit('rowSelect', { selectedRows: this.getSelectedRows() });
  }

  _handleSelectAll(checked) {
    this._state.displayData.forEach(row => {
      checked
        ? this._state.selectedRows.add(row._rowId)
        : this._state.selectedRows.delete(row._rowId);
    });
    this._updateRowSelectionUI();
    this._emit('rowSelect', { selectedRows: this.getSelectedRows() });
  }

  // 전체 재렌더 없이 선택 상태만 DOM에 반영
  _updateRowSelectionUI() {
    const tbody = this._elements.tbody;

    tbody.querySelectorAll('tr[data-row-id]').forEach(tr => {
      const isSelected = this._state.selectedRows.has(tr.dataset.rowId);
      tr.classList.toggle('dg-row--selected', isSelected);

      const checkbox = tr.querySelector('.dg-row-checkbox');
      if (checkbox) checkbox.checked = isSelected;
    });

    // 전체 선택 체크박스 상태 갱신 (indeterminate 포함)
    const selectAll = this._elements.selectAllCheckbox;
    if (selectAll) {
      const ids = this._state.displayData.map(r => r._rowId);
      const allSelected = ids.length > 0 && ids.every(id => this._state.selectedRows.has(id));
      const someSelected = ids.some(id => this._state.selectedRows.has(id));
      selectAll.checked = allSelected;
      selectAll.indeterminate = !allSelected && someSelected;
    }
  }

  // ==================== 컬럼 리사이즈 ====================

  _onResizeStart(e, colKey) {
    e.preventDefault();
    e.stopPropagation();

    const colEl = this._elements.colgroup.querySelector(`col[data-key="${colKey}"]`);
    const currentWidth = this._state.columnWidths[colKey] || 120;

    this._dragState = {
      type: 'resize',
      colKey,
      colEl,
      startX: e.clientX,
      startWidth: currentWidth,
    };

    // Pointer Capture: 핸들 밖으로 마우스가 나가도 이벤트를 계속 수신
    e.target.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  _onResizeMove(e) {
    if (!this._dragState || this._dragState.type !== 'resize') return;

    const delta = e.clientX - this._dragState.startX;
    const newWidth = Math.max(40, this._dragState.startWidth + delta);

    // colgroup의 col 요소만 변경하면 전체 컬럼 폭이 즉시 반영됨 (행 DOM 건드릴 필요 없음)
    if (this._dragState.colEl) {
      this._dragState.colEl.style.width = newWidth + 'px';
    }
  }

  _onResizeEnd(e) {
    if (!this._dragState || this._dragState.type !== 'resize') return;

    const delta = e.clientX - this._dragState.startX;
    const newWidth = Math.max(40, this._dragState.startWidth + delta);

    // 상태에 저장 (다음 렌더 시에도 폭 유지)
    this._state.columnWidths[this._dragState.colKey] = newWidth;

    // pinned 컬럼 폭이 바뀌면 나머지 pinned 오프셋도 재계산
    const col = this._config.columns.find(c => c.key === this._dragState.colKey);
    if (col && col.pinned) {
      this._computePinnedOffsets();
      this._renderHeader();
      this._renderRows();
    }

    this._emit('columnResize', { key: this._dragState.colKey, width: newWidth });

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    this._dragState = null;
  }

  // ==================== 인라인 편집 ====================

  _handleCellDblClick(e, rowId, colKey) {
    e.stopPropagation(); // 행 선택 이벤트 전파 차단

    const col = this._config.columns.find(c => c.key === colKey);
    if (!col || !col.editable) return;

    const row = this._getRowById(rowId);
    if (!row) return;

    // td 요소 직접 찾기
    const td = this._elements.tbody.querySelector(
      `tr[data-row-id="${rowId}"] td[data-col-key="${colKey}"]`
    );
    if (!td) return;

    const currentValue = row[colKey];
    const originalHTML = td.innerHTML;

    this._state.editingCell = { rowId, colKey };

    // 셀 내용을 input으로 교체
    const input = document.createElement('input');
    input.type = col.type === 'number' ? 'number' : 'text';
    input.className = 'dg-cell-editor';
    input.value = currentValue !== null && currentValue !== undefined ? currentValue : '';

    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    const commit = () => this._commitEdit(rowId, colKey, input.value, td, col);
    const cancel = () => this._cancelEdit(td, originalHTML);

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', commit); cancel(); }
    });
  }

  _commitEdit(rowId, colKey, rawValue, td, col) {
    this._state.editingCell = null;

    // 타입에 맞게 값 변환
    let newValue = rawValue;
    if (col && col.type === 'number') newValue = rawValue === '' ? null : Number(rawValue);

    const row = this._getRowById(rowId);
    if (!row) return;

    const oldValue = row[colKey];

    // 원본 데이터 배열 모두 업데이트
    [this._state.originalData, this._state.filteredData, this._state.displayData].forEach(arr => {
      const target = arr.find(r => r._rowId === rowId);
      if (target) target[colKey] = newValue;
    });

    // 전체 재렌더 없이 해당 셀만 업데이트
    if (td) {
      td.innerHTML = this._renderCell({ ...row, [colKey]: newValue }, col);
    }

    this._emit('cellEdit', {
      rowId,
      key: colKey,
      oldValue,
      newValue,
      row: this._stripRowId({ ...row, [colKey]: newValue }),
    });
  }

  _cancelEdit(td, originalHTML) {
    this._state.editingCell = null;
    if (td) td.innerHTML = originalHTML;
  }

  // ==================== 행 드래그 정렬 ====================

  _initRowDragHandlers() {
    const tbody = this._elements.tbody;
    let dragRowId = null;
    let dropRowId = null;
    let dropBefore = true;

    // dragstart: 드래그 핸들에서만 시작 허용
    tbody.addEventListener('dragstart', e => {
      const handle = e.target.closest('.dg-drag-handle');
      const tr = e.target.closest('tr[data-row-id]');
      if (!handle || !tr) { e.preventDefault(); return; }

      dragRowId = tr.dataset.rowId;
      tr.classList.add('dg-row--dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragRowId);
    });

    // dragover: 드롭 위치 계산 및 시각적 힌트 표시
    tbody.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const tr = e.target.closest('tr[data-row-id]');
      if (!tr || tr.dataset.rowId === dragRowId) return;

      tbody.querySelectorAll('.dg-row--drop-before, .dg-row--drop-after').forEach(el => {
        el.classList.remove('dg-row--drop-before', 'dg-row--drop-after');
      });

      const rect = tr.getBoundingClientRect();
      dropBefore = e.clientY < rect.top + rect.height / 2;
      dropRowId = tr.dataset.rowId;
      tr.classList.add(dropBefore ? 'dg-row--drop-before' : 'dg-row--drop-after');
    });

    // dragleave: tbody 밖으로 나가면 힌트 제거
    tbody.addEventListener('dragleave', e => {
      if (!tbody.contains(e.relatedTarget)) {
        tbody.querySelectorAll('.dg-row--drop-before, .dg-row--drop-after').forEach(el => {
          el.classList.remove('dg-row--drop-before', 'dg-row--drop-after');
        });
      }
    });

    // drop: 실제 순서 변경
    tbody.addEventListener('drop', e => {
      e.preventDefault();
      tbody.querySelectorAll('.dg-row--dragging, .dg-row--drop-before, .dg-row--drop-after').forEach(el => {
        el.classList.remove('dg-row--dragging', 'dg-row--drop-before', 'dg-row--drop-after');
      });

      if (dragRowId && dropRowId && dragRowId !== dropRowId) {
        this._reorderRows(dragRowId, dropRowId, dropBefore);
      }
      dragRowId = null;
      dropRowId = null;
    });

    // dragend: 정리
    tbody.addEventListener('dragend', () => {
      tbody.querySelectorAll('.dg-row--dragging, .dg-row--drop-before, .dg-row--drop-after').forEach(el => {
        el.classList.remove('dg-row--dragging', 'dg-row--drop-before', 'dg-row--drop-after');
      });
      dragRowId = null;
    });
  }

  _reorderRows(fromId, toId, isBefore) {
    const data = this._state.originalData;

    const fromIdx = data.findIndex(r => r._rowId === fromId);
    const toIdx   = data.findIndex(r => r._rowId === toId);
    if (fromIdx === -1 || toIdx === -1) return;

    const [moved] = data.splice(fromIdx, 1);

    // splice 후 toId 인덱스가 바뀔 수 있으므로 다시 찾기
    const newToIdx = data.findIndex(r => r._rowId === toId);
    data.splice(isBefore ? newToIdx : newToIdx + 1, 0, moved);

    this._pipeline();
    this._emit('rowReorder', { data: this._state.originalData.map(r => this._stripRowId(r)) });
  }

  // ==================== 키보드 네비게이션 ====================

  _handleKeyDown(e) {
    if (this._state.editingCell) return; // 편집 중엔 무시
    if (!this._elements.wrapper.contains(document.activeElement)) return;

    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._moveFocus('down');
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._moveFocus('up');
        break;
      case 'PageDown':
        e.preventDefault();
        this._goToPage(this._state.currentPage + 1);
        break;
      case 'PageUp':
        e.preventDefault();
        this._goToPage(this._state.currentPage - 1);
        break;
      case 'Home':
        if (e.ctrlKey) { e.preventDefault(); this._goToPage(1); }
        break;
      case 'End':
        if (e.ctrlKey) {
          e.preventDefault();
          const totalPages = Math.ceil(this._state.filteredData.length / this._state.pageSize);
          this._goToPage(totalPages);
        }
        break;
    }
  }

  _moveFocus(direction) {
    const rows = [...this._elements.tbody.querySelectorAll('tr[data-row-id]')];
    if (rows.length === 0) return;

    let index = rows.findIndex(r => r.classList.contains('dg-row--focused'));
    rows.forEach(r => r.classList.remove('dg-row--focused'));

    index = direction === 'down'
      ? Math.min(index + 1, rows.length - 1)
      : Math.max(index - 1, 0);

    if (index < 0) index = 0;
    rows[index].classList.add('dg-row--focused');
    rows[index].scrollIntoView({ block: 'nearest' });
  }

  // ==================== CSV 내보내기 ====================

  _generateCSV(scope) {
    const data = scope === 'current' ? this._state.displayData : this._state.filteredData;
    const cols = this._config.columns.filter(col => !this._state.hiddenColumns.has(col.key));

    const header = cols.map(col => this._escapeCSV(col.title)).join(',');
    const rows = data.map(row =>
      cols.map(col => this._escapeCSV(row[col.key])).join(',')
    );

    return [header, ...rows].join('\r\n');
  }

  _downloadFile(content, filename) {
    const BOM = '﻿'; // UTF-8 BOM: 엑셀에서 한국어 깨짐 방지
    const blob = new Blob([BOM + content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ==================== 이벤트 시스템 ====================

  on(eventName, handler) {
    if (!this._eventListeners[eventName]) this._eventListeners[eventName] = [];
    this._eventListeners[eventName].push(handler);
    return this; // 체이닝 지원
  }

  off(eventName, handler) {
    if (!this._eventListeners[eventName]) return this;
    this._eventListeners[eventName] = this._eventListeners[eventName].filter(h => h !== handler);
    return this;
  }

  _emit(eventName, payload) {
    (this._eventListeners[eventName] || []).forEach(h => {
      try { h(payload); } catch (err) {
        console.error(`DataGrid 이벤트 오류 [${eventName}]:`, err);
      }
    });
  }

  // ==================== 유틸리티 ====================

  _getRowById(rowId) {
    return this._state.originalData.find(r => r._rowId === rowId) || null;
  }

  // _rowId 내부 필드를 제거한 순수 데이터 반환
  _stripRowId(row) {
    const { _rowId, ...data } = row;
    return data;
  }

  // XSS 방지용 HTML 이스케이프
  _escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // CSV 셀 값 이스케이프 (쉼표·따옴표·줄바꿈 처리)
  _escapeCSV(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // ==================== Public API ====================

  /** 데이터를 교체하고 전체 재렌더합니다 */
  setData(data) {
    this._state.originalData = this._assignRowIds(data);
    this._state.currentPage = 1;
    this._state.selectedRows.clear();
    this._pipeline();
    return this;
  }

  /** 현재 필터·정렬이 적용된 전체 데이터를 반환합니다 */
  getData() {
    return this._state.filteredData.map(r => this._stripRowId(r));
  }

  /** 선택된 행 데이터 배열을 반환합니다 */
  getSelectedRows() {
    return this._state.originalData
      .filter(row => this._state.selectedRows.has(row._rowId))
      .map(row => this._stripRowId(row));
  }

  /** 선택을 모두 초기화합니다 */
  clearSelection() {
    this._state.selectedRows.clear();
    this._updateRowSelectionUI();
    return this;
  }

  /** 로딩 상태를 전환합니다 */
  setLoading(bool) {
    this._state.isLoading = bool;
    this._elements.loadingOverlay.style.display = bool ? 'flex' : 'none';
    if (bool) this._elements.emptyOverlay.style.display = 'none';
    return this;
  }

  /**
   * CSV 파일로 내보냅니다
   * @param {'all'|'current'} scope 전체 필터 결과 | 현재 페이지
   */
  exportCSV(scope = 'all') {
    const csv = this._generateCSV(scope);
    const date = new Date().toISOString().slice(0, 10);
    this._downloadFile(csv, `${this._config.options.exportFilename}_${date}.csv`);
    return this;
  }

  /** 특정 컬럼 필터를 프로그래밍 방식으로 설정합니다 */
  setFilter(colKey, value) {
    this._state.columnFilters[colKey] = value;
    this._state.currentPage = 1;
    this._pipeline();
    return this;
  }

  /** 모든 필터를 초기화합니다 */
  clearFilters() {
    this._state.globalSearch = '';
    this._state.columnFilters = {};
    if (this._elements.searchInput) this._elements.searchInput.value = '';
    this._state.currentPage = 1;
    this._pipeline();
    return this;
  }

  /** 컬럼을 표시합니다 */
  showColumn(key) {
    this._state.hiddenColumns.delete(key);
    this._pipeline();
    return this;
  }

  /** 컬럼을 숨깁니다 */
  hideColumn(key) {
    this._state.hiddenColumns.add(key);
    this._pipeline();
    return this;
  }

  /** 현재 상태를 유지하면서 재렌더합니다 */
  refresh() {
    this._pipeline();
    return this;
  }

  /** 그리드를 정리합니다 (메모리 누수 방지) */
  destroy() {
    document.removeEventListener('pointermove', this._boundHandlers.onResizeMove);
    document.removeEventListener('pointerup',   this._boundHandlers.onResizeEnd);
    document.removeEventListener('keydown',     this._boundHandlers.onKeyDown);

    if (this._elements.container) {
      this._elements.container.innerHTML = '';
    }

    this._eventListeners = {};
    this._state = null;
    this._elements = null;
  }
}
