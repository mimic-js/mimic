import { randomUUID } from 'node:crypto';

export function createTodoStore() {
  const todos = new Map();

  return {
    list() {
      return [...todos.values()];
    },
    get(id) {
      return todos.get(id);
    },
    create(title) {
      const todo = { id: randomUUID(), title, done: false, createdAt: new Date().toISOString() };
      todos.set(todo.id, todo);
      return todo;
    },
    update(id, changes) {
      const todo = todos.get(id);
      if (!todo) return undefined;
      const updated = { ...todo, ...changes };
      todos.set(id, updated);
      return updated;
    },
    remove(id) {
      return todos.delete(id);
    }
  };
}
