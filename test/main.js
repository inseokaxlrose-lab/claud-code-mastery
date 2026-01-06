// 투두리스트 가져오는 함수
function getTodoList() {
    const todos = [
        { id: 1, title: 'Todo 1', completed: false },
        { id: 2, title: 'Todo 2', completed: true },
        { id: 3, title: 'Todo 3', completed: false },
    ];
    
    // 유효성 체크 로직 추가
    for (const todo of todos) {
        if (
            typeof todo.id !== 'number' || 
            typeof todo.title !== 'string' || 
            typeof todo.completed !== 'boolean'
        ) {
            throw new Error(`Invalid todo item: ${JSON.stringify(todo)}`);
        }
    }

    return todos;
}

// Todo 앱 클래스
class TodoApp {
    constructor() {
        this.todos = [];
        this.nextId = 1;
        this.init();
    }

    init() {
        // 초기 투두리스트 로드
        try {
            const initialTodos = getTodoList();
            this.todos = initialTodos.map(todo => ({ ...todo }));
            this.nextId = Math.max(...this.todos.map(t => t.id)) + 1;
        } catch (error) {
            console.error('Error loading initial todos:', error);
            this.todos = [];
        }

        // DOM 요소 참조
        this.todoInput = document.getElementById('todoInput');
        this.addBtn = document.getElementById('addBtn');
        this.todoList = document.getElementById('todoList');
        this.totalCount = document.getElementById('totalCount');
        this.completedCount = document.getElementById('completedCount');
        this.remainingCount = document.getElementById('remainingCount');

        // 이벤트 리스너 등록
        this.addBtn.addEventListener('click', () => this.addTodo());
        this.todoInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.addTodo();
            }
        });

        // 초기 렌더링
        this.render();
    }

    addTodo() {
        const title = this.todoInput.value.trim();
        
        if (!title) {
            alert('할 일을 입력해주세요!');
            return;
        }

        const newTodo = {
            id: this.nextId++,
            title: title,
            completed: false
        };

        // 유효성 검사
        if (
            typeof newTodo.id !== 'number' || 
            typeof newTodo.title !== 'string' || 
            typeof newTodo.completed !== 'boolean'
        ) {
            throw new Error(`Invalid todo item: ${JSON.stringify(newTodo)}`);
        }

        this.todos.push(newTodo);
        this.todoInput.value = '';
        this.render();
    }

    toggleTodo(id) {
        const todo = this.todos.find(t => t.id === id);
        if (todo) {
            todo.completed = !todo.completed;
            this.render();
        }
    }

    deleteTodo(id) {
        if (confirm('정말 삭제하시겠습니까?')) {
            this.todos = this.todos.filter(t => t.id !== id);
            this.render();
        }
    }

    render() {
        // 투두리스트 렌더링
        if (this.todos.length === 0) {
            this.todoList.innerHTML = '<li class="empty-state">할 일이 없습니다. 새로운 할 일을 추가해보세요! 🎉</li>';
        } else {
            this.todoList.innerHTML = this.todos.map(todo => `
                <li class="todo-item ${todo.completed ? 'completed' : ''}">
                    <input 
                        type="checkbox" 
                        class="todo-checkbox" 
                        ${todo.completed ? 'checked' : ''}
                        onchange="todoApp.toggleTodo(${todo.id})"
                    >
                    <span class="todo-title">${this.escapeHtml(todo.title)}</span>
                    <button class="delete-btn" onclick="todoApp.deleteTodo(${todo.id})">삭제</button>
                </li>
            `).join('');
        }

        // 통계 업데이트
        const total = this.todos.length;
        const completed = this.todos.filter(t => t.completed).length;
        const remaining = total - completed;

        this.totalCount.textContent = total;
        this.completedCount.textContent = completed;
        this.remainingCount.textContent = remaining;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// 앱 초기화
let todoApp;
document.addEventListener('DOMContentLoaded', () => {
    todoApp = new TodoApp();
});