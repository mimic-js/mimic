import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { CreateTaskDto } from './create-task.dto';

export interface Task {
  id: string;
  title: string;
  description: string;
  done: boolean;
}

@Injectable()
export class TasksService {
  private readonly tasks = new Map<string, Task>();

  findAll(): Task[] {
    return [...this.tasks.values()];
  }

  findOne(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundException(`Task ${id} not found`);
    return task;
  }

  create(input: CreateTaskDto): Task {
    const task: Task = { id: randomUUID(), title: input.title, description: input.description ?? '', done: false };
    this.tasks.set(task.id, task);
    return task;
  }

  complete(id: string): Task {
    const task = this.findOne(id);
    task.done = true;
    return task;
  }

  remove(id: string): void {
    this.findOne(id);
    this.tasks.delete(id);
  }
}
