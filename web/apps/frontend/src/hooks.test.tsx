import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateStats, type SessionSnapshot } from '@classpulse/shared-types';
const mocks = vi.hoisted(() => {
  const handlers: Record<string, (...args: any[]) => unknown> = {};
  const socket = { on: vi.fn((event:string,cb:(...args:any[])=>unknown)=>{handlers[event]=cb;}), emit: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), connected: false, auth: {} as {token?:string} };
  return {handlers,socket,api:vi.fn(),refreshAuth:vi.fn()};
});
vi.mock('socket.io-client',()=>({io:()=>mocks.socket}));
vi.mock('./api',()=>({api:mocks.api,refreshAuth:mocks.refreshAuth,getToken:()=> 'initial-token'}));
import {useSession} from './hooks';
const snapshot=(second:number,status:SessionSnapshot['status']='LOBBY'):SessionSnapshot=>({id:'s1',quizId:'q1',title:'Buổi học',roomCode:'123456',status,mode:'MANUAL',currentQuestionIndex:0,totalQuestions:2,currentQuestion:null,questionStartedAt:null,questionEndsAt:null,nextQuestionAt:null,serverTime:`2030-01-01T00:00:${String(second).padStart(2,'0')}Z`,createdAt:'2030-01-01T00:00:00Z',finishedAt:null,participantCount:0,answerCount:0,participants:[],stats:calculateStats([],0),results:[],classroomId:null,classroomName:null,examId:null,variantCode:null});
beforeEach(()=>{vi.clearAllMocks();mocks.socket.connected=false;mocks.socket.auth={};for(const key of Object.keys(mocks.handlers))delete mocks.handlers[key];mocks.api.mockResolvedValue(snapshot(1));mocks.refreshAuth.mockResolvedValue({accessToken:'renewed-token'});});
afterEach(()=>cleanup());
describe('restoring live sessions',()=>{
  it('hydrates from the server after every mount/reload',async()=>{
    const first=renderHook(()=>useSession('s1'));
    await waitFor(()=>expect(first.result.current.data?.status).toBe('LOBBY'));
    first.unmount();
    mocks.api.mockResolvedValue(snapshot(20,'QUESTION_CLOSED'));
    const second=renderHook(()=>useSession('s1'));
    await waitFor(()=>expect(second.result.current.data?.status).toBe('QUESTION_CLOSED'));
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.api).toHaveBeenLastCalledWith('/sessions/s1');
  });
  it('joins its authenticated session and ignores stale realtime snapshots',async()=>{
    const {result}=renderHook(()=>useSession('s1'));
    await waitFor(()=>expect(result.current.loading).toBe(false));
    await act(async()=>{mocks.handlers.connect();});
    expect(mocks.socket.emit).toHaveBeenCalledWith('session:join',{sessionId:'s1'});
    act(()=>{mocks.handlers['session:update'](snapshot(30,'QUESTION_CLOSED'));});
    act(()=>{mocks.handlers['session:update'](snapshot(20,'QUESTION_ACTIVE'));});
    expect(result.current.data?.status).toBe('QUESTION_CLOSED');
    act(()=>{mocks.handlers['session:update']({...snapshot(40),id:'different-room'});});
    expect(result.current.data?.id).toBe('s1');
  });
  it('refreshes authentication and explicitly reconnects after server JWT expiry disconnect',async()=>{
    const {result}=renderHook(()=>useSession('s1'));
    await waitFor(()=>expect(result.current.loading).toBe(false));
    await act(async()=>{mocks.handlers.disconnect('io server disconnect');});
    expect(mocks.refreshAuth).toHaveBeenCalledTimes(1);
    expect(mocks.socket.auth).toEqual({token:'renewed-token'});
    expect(mocks.socket.connect).toHaveBeenCalledTimes(1);
  });
  it('does not refresh tokens on temporary network errors',async()=>{
    const {result}=renderHook(()=>useSession('s1'));
    await waitFor(()=>expect(result.current.loading).toBe(false));
    act(()=>{mocks.handlers.connect_error(new Error('websocket error'));});
    expect(mocks.refreshAuth).not.toHaveBeenCalled();
  });
  it('does not reconnect a socket after its component has unmounted',async()=>{
    let resolveRefresh:(value:unknown)=>void=()=>{};
    mocks.refreshAuth.mockReturnValue(new Promise(resolve=>{resolveRefresh=resolve;}));
    const hook=renderHook(()=>useSession('s1'));
    await waitFor(()=>expect(hook.result.current.loading).toBe(false));
    act(()=>{mocks.handlers.disconnect('io server disconnect');});
    hook.unmount();
    await act(async()=>{resolveRefresh({accessToken:'late-token'});});
    expect(mocks.socket.connect).not.toHaveBeenCalled();
  });
});
