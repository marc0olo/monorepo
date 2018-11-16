import * as cf from "@counterfactual/cf.js";

import { Action, ActionExecution } from "./action";
import { Opcode } from "./instructions";
import { Middleware, OpGenerator } from "./middleware/middleware";
import { applyMixins } from "./mixins/apply";
import { NotificationType, Observable } from "./mixins/observable";
import { InstructionMiddlewareCallback, OpCodeResult } from "./types";
import { Log } from "./write-ahead-log";

export class InstructionExecutorConfig {
  constructor(
    readonly responseHandler: cf.legacy.node.ResponseSink,
    readonly opGenerator: OpGenerator,
    readonly network: cf.legacy.network.NetworkContext,
    readonly channel: cf.legacy.channel.StateChannelInfo
  ) {}
}

export class InstructionExecutor implements Observable {
  /**
   * The object responsible for processing each Instruction in the Vm.
   */
  public middleware!: Middleware;
  /**
   * The delegate handler we send responses to.
   */
  public responseHandler: cf.legacy.node.ResponseSink;
  /**
   * The channel on which the machine is operating.
   */
  public channel: cf.legacy.channel.StateChannelInfo;
  /**
   * The network context for which the machine is executing a protocol.
   */
  public network: cf.legacy.network.NetworkContext;

  // Observable
  public observers: Map<NotificationType, Function[]> = new Map();
  private opGenerator: OpGenerator;

  constructor(config: InstructionExecutorConfig) {
    this.responseHandler = config.responseHandler;
    this.network = config.network;
    this.opGenerator = config.opGenerator;
    this.channel = config.channel;
    this.middleware = new Middleware(
      this.channel!,
      this.opGenerator,
      this.network
    );
  }

  public registerObserver(type: NotificationType, callback: Function) {}
  public unregisterObserver(type: NotificationType, callback: Function) {}
  public notifyObservers(type: NotificationType, data: object) {}

  /**
   * Restarts all protocols that were stopped mid execution, and returns when
   * they all finish.
   */
  public async resume(log: Log) {
    const executions = this.buildExecutionsFromLog(log);
    return executions.reduce(
      (promise, exec) => promise.then(_ => this.run(exec)),
      Promise.resolve()
    );
  }

  /**
   * @returns all unfinished protocol executions read from the db.
   */
  public buildExecutionsFromLog(log: Log): ActionExecution[] {
    return Object.keys(log).map(key => {
      const entry = log[key];
      const action = new Action(
        entry.requestId,
        entry.actionName,
        entry.clientMessage,
        entry.isAckSide
      );
      const execution = new ActionExecution(
        action,
        entry.instructionPointer,
        entry.clientMessage,
        this
      );
      execution.results = entry.results;
      action.execution = execution;
      return execution;
    });
  }

  public receiveClientActionMessageAck(
    msg: cf.legacy.node.ClientActionMessage
  ) {
    this.execute(new Action(msg.requestId, msg.action, msg, true));
  }

  public receiveClientActionMessage(msg: cf.legacy.node.ClientActionMessage) {
    this.execute(new Action(msg.requestId, msg.action, msg, false));
  }

  public async execute(action: Action) {
    const execution = action.makeExecution(this);
    await this.run(execution);

    this.notifyObservers("actionCompleted", {
      type: "notification",
      NotificationType: "actionCompleted",
      data: {
        requestId: action.requestId,
        name: action.name,
        results: execution.results,
        clientMessage: action.clientMessage
      }
    });
  }

  public async run(execution: ActionExecution) {
    try {
      // Temporary error handling for testing resuming protocols
      let val;
      // TODO: Bizarre syntax...
      // https://github.com/counterfactual/monorepo/issues/123
      for await (val of execution) {
      }
      this.sendResponse(execution, cf.legacy.node.ResponseStatus.COMPLETED);
    } catch (e) {
      console.error(e);
      this.sendResponse(execution, cf.legacy.node.ResponseStatus.ERROR);
    }
  }

  public sendResponse(
    execution: ActionExecution,
    status: cf.legacy.node.ResponseStatus
  ) {
    if (execution.action.isAckSide) {
      return;
    }

    this.responseHandler.sendResponse(
      new cf.legacy.node.Response(execution.action.requestId, status)
    );
  }

  public mutateState(channel: cf.legacy.channel.StateChannelInfo) {
    Object.assign(this.channel, channel);
  }

  public register(scope: Opcode, method: InstructionMiddlewareCallback) {
    this.middleware.add(scope, method);
  }
}

export class Context {
  public results: OpCodeResult[] = Object.create(null);
  public instructionPointer: number = Object.create(null);
  public instructionExecutor: InstructionExecutor = Object.create(null);
}

applyMixins(InstructionExecutor, [Observable]);
