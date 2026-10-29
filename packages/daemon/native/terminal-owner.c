/* ALP terminal owner protocol 1. Native-only spawn, lifetime acquisition, signals and reap.
 * No PID/group signal fallback. See README.md for proof obligations and platform limits. */
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <time.h>
#ifdef __APPLE__
#include <util.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_traps.h>
#include <mach/task_info.h>
/* Approved private ABI, XNU xnu-12377.1.9 bsd/sys/proc_info_private.h, flavor17.
 * Keep the complete 56-byte layout; parent identity is NEVER adoption authority. */
struct uniqinfo { uint8_t uuid[16]; uint64_t unique, parent; int32_t version, original_parent_version; uint64_t reserved[2]; };
_Static_assert(sizeof(struct uniqinfo) == 56, "private ABI size");
#else
#include <pty.h>
#include <dirent.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <linux/magic.h>
#endif
#define MAX_TRACKED 4096
#define QUEUE (1024 * 1024)
#ifndef START_TIMEOUT_MS
#define START_TIMEOUT_MS 3000
#endif
typedef struct {
  pid_t pid;
#ifdef __APPLE__
  uint64_t unique;
#else
  int fd;
#endif
} identity;
static identity known[MAX_TRACKED];
static size_t count;
static pid_t root;
static int scanning_failed, held = 1;
static long long clock_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (long long)t.tv_sec*1000+t.tv_nsec/1000000; }
static void event(const char *s) { (void)!write(3, s, strlen(s)); }
#ifdef __APPLE__
static int unique(pid_t p, struct uniqinfo *u) { memset(u, 0, sizeof(*u)); errno = 0; return proc_pidinfo(p, 17, 0, u, sizeof(*u)) == sizeof(*u) && u->unique != 0; }
static int token(pid_t p, audit_token_t *t) {
  mach_port_t task = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), p, &task) != KERN_SUCCESS) return 0;
  mach_msg_type_number_t n = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t r = task_info(task, TASK_AUDIT_TOKEN, (task_info_t)t, &n);
  mach_port_deallocate(mach_task_self(), task);
  return r == KERN_SUCCESS && n == TASK_AUDIT_TOKEN_COUNT && t->val[5] == (uint32_t)p;
}
static int acquire(pid_t p, identity *out, int session) {
  struct uniqinfo a, b; audit_token_t t;
  if (!held || !unique(p, &a)) return 0;
  if (session && getsid(p) != root) return 0;
  if (!token(p, &t) || !unique(p, &b) || a.unique != b.unique || t.val[7] != (uint32_t)b.version) return 0;
  out->pid = p; out->unique = a.unique; return 1;
}
/* 0 exited, 1 live, 2 uncertain. Never infer live from a failed task-port lookup. */
static int status(identity *id) {
  if (id->pid == root) { siginfo_t info = {0}; if (waitid(P_PID, root, &info, WEXITED|WNOHANG|WNOWAIT) == 0 && info.si_pid == root) return 0; }
  struct uniqinfo u; if (!unique(id->pid, &u)) return errno == ESRCH ? 0 : 2;
  if (u.unique != id->unique) return 0;
  struct proc_bsdinfo b;
  if (proc_pidinfo(id->pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b)) return 2;
  struct uniqinfo after; if (!unique(id->pid, &after)) return errno == ESRCH ? 0 : 2;
  if (after.unique != id->unique) return 0;
  return b.pbi_status == 5 /* SZOMB */ ? 0 : 1;
}
static void bound_signal(identity *id, int sig) {
  for (int tries = 0; tries < 4; tries++) {
    identity fresh; audit_token_t t; struct uniqinfo u;
    if (!acquire(id->pid, &fresh, 0) || fresh.unique != id->unique || !token(id->pid, &t) || !unique(id->pid, &u) || u.unique != id->unique || t.val[7] != (uint32_t)u.version) continue;
    int r = proc_signal_with_audittoken(&t, sig);
    if (r == 0 || r != ESRCH) return;
  }
}
static void remember(pid_t p) {
  identity id;
  if (!acquire(p, &id, 1)) return;
  for (size_t i=0; i<count; i++) if (known[i].unique == id.unique) return;
  if (count == MAX_TRACKED) { scanning_failed = 1; return; }
  known[count++] = id;
}
static void discover(void) {
  if (!held) return;
  int bytes = proc_listallpids(NULL, 0);
  if (bytes <= 0 || bytes > 1024*1024) { scanning_failed = 1; return; }
  /* proc_listallpids(NULL) returns estimated process COUNT, not bytes. */
  size_t capacity = (size_t)bytes + 256;
  pid_t *pids = calloc(capacity, sizeof(pid_t));
  if (!pids) { scanning_failed = 1; return; }
  int n = proc_listallpids(pids, (int)(capacity*sizeof(pid_t)));
  if (n < 0 || (size_t)n >= capacity) scanning_failed = 1;
  else for (int i=0; i<n; i++) if (pids[i]>1) remember(pids[i]);
  free(pids);
}
static int capability(void) {
  struct uniqinfo a, b; audit_token_t t;
  return unique(getpid(), &a) && token(getpid(), &t) && unique(getpid(), &b) && a.unique == b.unique && t.val[7] == (uint32_t)b.version;
}
#else
static int pid_signal(int fd, int sig) { return (int)syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0); }
static int proc_stat(int dir, pid_t *sid, char *state) {
  int f = openat(dir, "stat", O_RDONLY|O_CLOEXEC); if (f < 0) return 0;
  char buf[8192]; ssize_t n = read(f, buf, sizeof(buf)-1); int saved=errno; close(f); errno=saved;
  if (n <= 0) { if(n==0) errno=EIO; return 0; } buf[n]=0;
  char *end = strrchr(buf, ')'); int pp, pg, s;
  if (!end || sscanf(end+1, " %c %d %d %d", state, &pp, &pg, &s) != 4) { errno=EIO; return 0; }
  *sid = (pid_t)s; return 1;
}
static int acquire(pid_t p, identity *out, int session) {
  if (!held) return 0;
  char name[64]; snprintf(name, sizeof(name), "/proc/%d", p);
  int f=open(name, O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW); if (f<0) return 0;
  pid_t sid; char state;
  if (!proc_stat(f, &sid, &state) || (session && sid != root)) { close(f); return 0; }
  out->pid=p; out->fd=f; return 1;
}
static int status(identity *id) {
  pid_t sid; char state;
  if (!proc_stat(id->fd, &sid, &state)) return errno == ENOENT || errno == ESRCH ? 0 : 2;
  return state == 'Z' || state == 'X' ? 0 : 1;
}
static void bound_signal(identity *id, int sig) { (void)pid_signal(id->fd, sig); }
static void remember(pid_t p) {
  identity id;
  if (!acquire(p, &id, 1)) return;
  struct stat st, old; if (fstat(id.fd,&st)) { close(id.fd); scanning_failed=1; return; }
  for (size_t i=0;i<count;i++) if (!fstat(known[i].fd,&old) && old.st_dev==st.st_dev && old.st_ino==st.st_ino) { close(id.fd); return; }
  if (count==MAX_TRACKED) { scanning_failed=1; close(id.fd); return; }
  known[count++]=id;
}
static void discover(void) {
  if (!held) return;
  DIR *d=opendir("/proc"); if (!d) { scanning_failed=1; return; }
  struct dirent *e;
  while ((e=readdir(d))) { char *end; long p=strtol(e->d_name,&end,10); if (*e->d_name && !*end && p>1 && p<=INT32_MAX) remember((pid_t)p); }
  closedir(d);
}
static int capability(void) {
  /* Reject a proc mount in a different PID namespace (including numeric aliases).
   * The mount must be kernel procfs; /proc/self must report our local PID and SID. */
  int self=open("/proc/self",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  if(self<0) return 0;
  struct statfs fs; pid_t sid; char state;
  int statfd=openat(self,"stat",O_RDONLY|O_CLOEXEC); char buf[128]={0};
  ssize_t n=statfd<0?-1:read(statfd,buf,sizeof(buf)-1);
  if(statfd>=0) close(statfd);
  int ownns=openat(self,"ns/pid",O_RDONLY|O_CLOEXEC);
  int mountns=open("/proc/1/ns/pid",O_RDONLY|O_CLOEXEC);
  struct stat a,b;
  int same_namespace=ownns>=0 && mountns>=0 && !fstat(ownns,&a) && !fstat(mountns,&b) && a.st_dev==b.st_dev && a.st_ino==b.st_ino;
  if(ownns>=0) close(ownns);
  if(mountns>=0) close(mountns);
  int namespace_ok=same_namespace && n>0 && strtol(buf,NULL,10)==getpid() && !fstatfs(self,&fs) && fs.f_type==PROC_SUPER_MAGIC && proc_stat(self,&sid,&state) && sid==getsid(0);
  close(self); if(!namespace_ok) return 0;
  identity id; pid_t saved=root; root=getsid(0);
  int ok=acquire(getpid(), &id, 1); root=saved;
  if (!ok) return 0;
  int r=pid_signal(id.fd, 0); close(id.fd); return r==0;
}
#endif
static void signal_all(int sig) { for (size_t i=0;i<count;i++) if (status(&known[i]) != 0) bound_signal(&known[i], sig); }
static void nonblock(int f) { int flags=fcntl(f,F_GETFL); if(flags>=0) fcntl(f,F_SETFL,flags|O_NONBLOCK); }
static void close_extra(void) {
#ifdef __APPLE__
  int n = getdtablesize();
  for(int i=3;i<n;i++) close(i);
#else
  long n=sysconf(_SC_OPEN_MAX); if(n<0) n=65536;
  for(int i=3;i<n;i++) close(i);
#endif
}
/* Startup failure owns the unreaped root but must never wait indefinitely.
 * Gate EOF prevents exec. All optional signals still use a verified identity. */
static int abort_start(int master, int gate) {
  close(gate);
  identity id;
  if(acquire(root,&id,0)) {
    bound_signal(&id,SIGKILL);
#ifndef __APPLE__
    close(id.fd);
#endif
  }
  long long deadline=clock_ms()+250; int reaped=0;
  do {
    siginfo_t info={0};
    if(waitid(P_PID,root,&info,WEXITED|WNOHANG|WNOWAIT)==0 && info.si_pid==root) { waitpid(root,NULL,WNOHANG); reaped=1; break; }
    usleep(1000);
  } while(clock_ms()<deadline);
  held=0; close(master);
  event("{\"error\":\"native_identity_unavailable\"}\n");
  char message[160]; snprintf(message,sizeof(message),"{\"cleanup\":true,\"observed\":1,\"live\":0,\"uncertain\":%d}\n",reaped?0:1); event(message);
  return 78;
}
int main(int argc, char **argv) {
  signal(SIGPIPE,SIG_IGN); signal(SIGCHLD,SIG_DFL);
  if (argc==2 && !strcmp(argv[1],"--capability")) { if (!capability()) return 78; puts("alp-terminal-owner:1"); return 0; }
  if (argc<6 || !capability()) { event("{\"error\":\"native_capability_unavailable\"}\n"); return 78; }
  int cols=atoi(argv[1]),rows=atoi(argv[2]),grace=atoi(argv[3]);
  if(cols<1 || cols>1000 || rows<1 || rows>1000 || grace<0 || grace>10000) return 64;
  unsigned char *out=malloc(QUEUE),*input=malloc(QUEUE);
  if(!out || !input) { free(out); free(input); return 71; }
  int gate[2],started[2]; if(pipe(gate)||pipe(started)) return 71;
  struct winsize ws={.ws_col=(unsigned short)cols,.ws_row=(unsigned short)rows}; int master;
  root=forkpty(&master,NULL,NULL,&ws);
  if (root<0) return 71;
  if (!root) {
    close(gate[1]); close(started[0]);
    char ready=getsid(0)==getpid()?'S':'E';
    if(write(started[1],&ready,1)!=1) _exit(126);
    char release=0; if(read(gate[0],&release,1)!=1 || release!='G' || ready!='S') _exit(126);
    close_extra(); signal(SIGPIPE,SIG_DFL);
    if(chdir(argv[4])) _exit(126);
    execv(argv[5],&argv[5]); _exit(127);
  }
  close(gate[0]); close(started[1]); char ready=0;
  struct pollfd startup[3]={{started[0],POLLIN,0},{0,0,0},{4,POLLIN,0}};
  int available=poll(startup,3,START_TIMEOUT_MS);
  int startok=available>0 && !(startup[1].revents&(POLLHUP|POLLERR)) && !(startup[2].revents&(POLLIN|POLLHUP|POLLERR)) && (startup[0].revents&POLLIN) && read(started[0],&ready,1)==1 && ready=='S';
  close(started[0]);
  identity first;
  if(!startok || !acquire(root,&first,1)) return abort_start(master,gate[1]);
  known[count++]=first;
  if(write(gate[1],"G",1)!=1) return abort_start(master,gate[1]);
  close(gate[1]);
  char msg[256]; snprintf(msg,sizeof(msg),"{\"ready\":%d,\"protocol\":1}\n",root); event(msg);
  nonblock(master); nonblock(0); nonblock(1); nonblock(4);
  size_t outn=0,inn=0; char commands[256]; size_t cn=0;
  int cleaning=0, root_notified=0, code=0, sig=0, io_failed=0; long long start=0, lastscan=0;
  for (;;) {
    long long now=clock_ms();
    if(now-lastscan>=20) { discover(); lastscan=now; }
    siginfo_t info={0};
    if(!root_notified && waitid(P_PID,root,&info,WEXITED|WNOHANG|WNOWAIT)==0 && info.si_pid==root) {
      root_notified=1; code=info.si_code==CLD_EXITED?info.si_status:0; sig=info.si_code==CLD_EXITED?0:info.si_status;
      snprintf(msg,sizeof(msg),"{\"exitCode\":%d,\"signal\":%d}\n",code,sig); event(msg); cleaning=cleaning?cleaning:1;
    }
    if(io_failed && !cleaning) cleaning=1;
    if(cleaning==1) { start=now; discover(); signal_all(SIGHUP); cleaning=2; }
    if(cleaning>=2 && now-start>=grace) { discover(); signal_all(SIGKILL); cleaning=3; }
    if(cleaning==3 && now-start>=grace+250) break;
    struct pollfd fds[4]={{0,inn<QUEUE?POLLIN:0,0},{master,(short)((outn<QUEUE?POLLIN:0)|(inn?POLLOUT:0)),0},{1,outn?POLLOUT:0,0},{4,POLLIN,0}};
    if(poll(fds,4,10)<0 && errno!=EINTR) { io_failed=1; continue; }
    if(fds[0].revents&POLLIN) { ssize_t n=read(0,input+inn,QUEUE-inn); if(n>0) inn+=(size_t)n; else if(n==0) cleaning=cleaning?cleaning:1; }
    if(fds[0].revents&(POLLHUP|POLLERR)) cleaning=cleaning?cleaning:1;
    if(fds[1].revents&POLLIN) { ssize_t n=read(master,out+outn,QUEUE-outn); if(n>0) outn+=(size_t)n; }
    if(fds[1].revents&POLLOUT) { ssize_t n=write(master,input,inn); if(n>0) {inn-=(size_t)n;memmove(input,input+n,inn);} }
    if(fds[2].revents&POLLOUT) { ssize_t n=write(1,out,outn); if(n>0) {outn-=(size_t)n;memmove(out,out+n,outn);} else if(errno!=EAGAIN&&errno!=EINTR) io_failed=1; }
    if(fds[2].revents&(POLLHUP|POLLERR)) io_failed=1;
    if(fds[3].revents&POLLIN) {
      char b[128]; ssize_t n=read(4,b,sizeof(b));
      for(ssize_t i=0;i<n;i++) { if(b[i]=='\n') { commands[cn]=0; int c,r; if(!strcmp(commands,"C")) cleaning=cleaning?cleaning:1; else if(sscanf(commands,"R %d %d",&c,&r)==2 && c>0&&c<=1000&&r>0&&r<=1000) { ws.ws_col=(unsigned short)c;ws.ws_row=(unsigned short)r; ioctl(master,TIOCSWINSZ,&ws); } cn=0; } else if(cn<sizeof(commands)-1) commands[cn++]=b[i]; else {io_failed=1;cn=0;} }
    }
    if(fds[3].revents&(POLLHUP|POLLERR)) cleaning=cleaning?cleaning:1;
  }
  /* Last scan and verification happen BEFORE final root reap: SID still reserved. */
  discover(); signal_all(SIGKILL); usleep(20000);
  int live=0,uncertain=scanning_failed+io_failed;
  for(size_t i=0;i<count;i++) { int s=status(&known[i]); if(s==1) live++; else if(s==2) uncertain++; }
  siginfo_t final={0};
  if(waitid(P_PID,root,&final,WEXITED|WNOHANG|WNOWAIT)==0 && final.si_pid==root) {
    held=0; waitpid(root,NULL,WNOHANG);
  } else { /* Never blocking reap of a live/unverifiable root; no adoption after this point. */
    held=0; uncertain++;
  }
  close(master);
  /* Best-effort bounded tail. Protocol completion is distinct from PTY output. */
  if(outn) (void)!write(1,out,outn);
  snprintf(msg,sizeof(msg),"{\"cleanup\":true,\"observed\":%zu,\"live\":%d,\"uncertain\":%d}\n",count,live,uncertain); event(msg);
#ifndef __APPLE__
  for(size_t i=0;i<count;i++) close(known[i].fd);
#endif
  free(out);free(input); return live||uncertain?2:0;
}
