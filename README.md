Note: This repository and documentation is a work in progress. Its intention is to give a general level of insight into finished, ongoing as well as planned work.

### Goals

* Allow anyone with familiarity with modern deployment to be able to deploy to Kubernetes.
* Significantly lower the complexity involved in deploying to Kubernetes.
* Significantly raise the level of abstraction in describing deployments.
* Allow for the possibility of adding non-k8s "backend implementations" at a much later stage of the project while retaining the "k8s-native feel" of the initial API, language and implementation.
* Provide a "Deployment DSL" of sorts that allows description of deployment scenarios in backend-independent terms, while cleanly mapping to the fantastic low-level abstractions that Kubernetes (and major components from the cloud-native ecosystem) provides.
* Provide an easy to use implementation of "k8s-native CI/CD" based on the idea of "gitops".
* Establish good practices for reproducible (re-)building of k8s clusters from scratch, from a single "ops" git repository.
* Support at least GitHub and GitLab as "sources of truth" for code & configuration.

### Current Limitations

* Only supports GitLab right now; all relevant repositories must be hosted on the same GL instance.

### General Workflow

1. Create a designated "gitops" repository.
1. Create a `.diploid.conf.js` which contains general configuration required for operating the k8s cluster and deploying the services, like GitLab username & token, Docker registry address, domains to be used for ingress etc.
1. Initially deploy the cluster-side component with some initial configuration from the above configuration file by executing the CLI's `init` command from a shell inside the gitops repo.
1. The cluster-side component reads in all information available to it: Everything in the `.diploid.conf.js`, diploid service configuration files in the same folder inside the ops repo, and merges that with relevant information from the individual services' repositories.
1. It adds git push hooks so it can execute its CI & CD functions as appropriate.
1. Whenever a change is made to (relevant) configuration in the ops repository, or in a service's repo, all affected containers will be (re-)built, and deployment triggered.

### Configuration

It should be possible to...

* specify which branches should be deployed into which environments.
* configure some branches to trigger deployment of new instances of all comprising services, while other branches can be as lightweight as needing only a single service to be deployed, while reusing existing instances for all other services.

### Ease of use enhancements

Free the user from...

* having to resort to silly and repetitive container build / Dockerfile hacks such as
  * using custom docker-entrypoint.sh in order to replace variables in various configuration files of services that do not natively understand configuring themselves from the environment or similar, at runtime
* having to repeat themselves, e.g. by having to specify the same names, ports, labels etc multiple times in the same or across multiple documents
* having to memorize or copy-and-paste configuration patterns for common tasks such as...
  * configuring CORS for web frontends,
  * building and configuring deployment for static assets like single-page apps,
  * running only a single instance of an app per host, or preferring to spread out deployments across all available hosts (before possibly at some point deploying more than one instance on a host),

Make it straightforward for the user to...

* define shared configuration and reuse that across files, services and repositories.

### Definitions & Terminology

We are striving to use terminology that aligns well with what any practicioner of modern DevOps / SRE would easily and naturally understand and often use themselves in their day to day communications as well as thinking.

**environment**

* source of configuration common to all units of deployment targeting it
* a namespace containing deployment units specifically configured for a particular shared purpose, often according to a part of the development cycle (eg. development, staging, production)

**gitops repository**

* the idea of using a git repository as the complete source of truth for the desired state of a system, with pushes to the repository being translated by automated tooling into some form of orchestrator that will strive to accomplish the desired state
  * \*state: refers to any not externally managed state, i.e. not database state or application state, such as might be managed by an NFS-based (cluster-wide) file service, image-specific replication mechanisms etc

### Examples

Let's assume the following:

* Gitops repository is called "ops", with remote "https://gitlab.myorg.com/ops", and the main diploid config file is located in the folder "deployment/app"
* we want to deploy the following services: "backend", "frontend", "mysql"

```js
// ops/deployment/app/.diploid.conf.js
config = {
    // gitlab code & registry access currently only working via personal tokens
    user: 'seeekr',
    gitlabToken: 'personaltokenfromgitlab',
    // omitting the registry host and path means the ops repository's remote location will be used
    // ie. https://gitlab.myorg.com:4567
    registry: ':4567', 
    // which domain to use as basis for all ingresses
    // the value for 'domain' is parsed such that anything that looks like an option
    // will be treated as such, and the rest will remain as the actual string value.
    // this helps with not blowing up the line count and amount of whitespace human readers
    // have to parse in order to understand the configuration
    domain: 'myorg.com mapEnv=subdomain', // "map every environment to its own subdomain"
    production: {branch: 'master'}, // by default, deploy all master branches to production
    dev: {branch: '*'}, // all other branches should go to the dev env
    // in the services section we specify optional defaults for all or individual services
    services: {
        // while $domain here resolves to $env.$domain, we want to also include the service $name in the domain
        // so we can refer to them easily e.g. from our frontend running in the users' browsers
        defaults: {url: 'https://$name.$domain'},
        // let's say for various reasons we're currently using the 'release' branch of our backend repo
        // as the source for production deployments
        backend: { production: {branch: 'release'}, },
    },
    // this section specifies global variables that can be referenced from anywhere
    // references are supported (which will eventually be everywhere they would be meaningful)
    vars: {
        // let's say we were planning to soon deploying an additional service that would also require
        // email sending configuration, so we put it here for reusing it most easily
        mailer: {
            host: 'myproductionmailer.com',
            user: 'myuser',
            password: 'mypassword',
        },
        // (this is just to demonstrate a minor feature further below, aka using multiple referenced paths in from() expressions)
        all_backends: { gurgle: 'yes', },
    },
}
```

Service configuration files are named as `<service name>.k8s.js`.

```js
// ops/deployment/app/backend.k8s.js
config = {
    // override the repo name if it's not just the name of the service
    repo: 'php-backend',
    // enable CORS headers for all domains
    cors: true, // cors: '$domain' and other variations are on the roadmap
    // let's say the code here expects a yaml file with configuration, so instead of copy-pasting a bunch of
    // build steps across shell and Docker files, let's configure this declaratively:
    // 'configure' specifies something that needs to happen basically at runtime / startup time;
    // (enhancements to this are planned, that will allow to distinguish between configuration that needs to happen
    // at a container's start time vs build time)
    configure: {
        'app/config/parameters.yml': {
            // let's say the yml expects some yaml config like this:
            // parameters:
            // - db_host: ...
            // - db_user: ...
            // this is how we map that without repeating ourselves or overspecifying things that the machine can easily match / infer:
            // - paths with dots are resolved as you would expect
            // - the glob means: match the property names on the right with the best matching name on the left, minus the non-glob part,
            //   ie. if we have a db_user on the left and the standard MYSQL_USER env variable on the right, ... it is matched as you would expect;
            //   this is something that is supposed to "just work (tm)", but at least for now is fairly imperfect and will take some more time to get right
            //   so for now users would have to learn by trial and error and perhaps mostly stick to official examples or so;
            //   but most importantly, the idea here is for the machine to be fed with the heuristics that WE use to make logical sense of stuff that is sensibly named mapping to each other
            //   and thus behave mostly as well as we would, and get the job done, while keeping the human DRY
            // - for any service its host and port, if applicable, are automatically made available, even though it's not something you usually specify in its own
            //   environment (because that would be redundant, of course)
            'parameters.db_*': from(services.mysql.env),
            // for production, also apply all configuration found in vars.mailer and vars.all_backends
            'env=production parameters': from(vars.mailer, vars.all_backends),
        },
    },
}
```

```js
// ops/deployment/app/mysql.k8s.js
config = {
    // we want to deploy it as statefulset
    stateful: true,
    // please only 1 per node
    unique: 'per node',
    // and for now we also just want to run it on a particular node, for legacy reasons
    node: 'k1',
    // use really old mysql image, cause that's how we roll
    image: 'mysql:5.5',
    // these are referenced by the backend service, and are matched to what it expects
    // including matching letter case and prefixes, because these things should be easy enough
    // for a machine to match and humans should not be made to spell those out
    // otherwise just standard Docker MySQL image configuration
    env: {
        MYSQL_ROOT_PASSWORD: 'UDACwQDb4JoYgWrXW8VK85oAu5RUzam7',
        MYSQL_DATABASE: 'app',
        MYSQL_USER: 'appuser',
        MYSQL_PASSWORD: 'fLrDpjeUvOLWYFPdAAJpHeuunKiTd8ee',
    },
    // map a host volume from /docker/data/... to /var/lib/mysql inside the container
    // variable expansion works as you would expect
    map: 'host:/docker/data/$env/$name:/var/lib/mysql',
    // for better performance we want our clients to connect directly
    service: 'proxy=false',
    // we don't need an http ingress for this service
    ingress: false,
    // environment-specific configuration overrides
    byEnv: {
        // for this environment
        dev: {
            // configure 'env' like this
            env: {
                MYSQL_ALLOW_EMPTY_PASSWORD: true,
                MYSQL_USER: 'root',
                // we don't have a syntax yet for specifying "remove this key from the map if it existed previously",
                // and in this case we can set it to empty string to achieve the same goal
                MYSQL_ROOT_PASSWORD: '',
            },
        },
    },
}
```

**WARNING:** MOST FEATURES IN THE CONFIGURATION BELOW ARE CURRENTLY BEING IMPLEMENTED, DO NOT WORK YET, AND ARE SUBJECT TO CHANGE!

```js
// frontend.k8s.js
config = {
    // ATTENTION: MOST FEATURES IN THE CONFIGURATION BELOW ARE CURRENTLY BEING IMPLEMENTED, DO NOT WORK YET, AND ARE SUBJECT TO CHANGE!
    // but it would allow one to apply configuration before building a container image
    build: {
        configure: {
            // let's say that for production we need to override the BACKEND_API_ROOT variable, at build time
            'env=production settings.json': {
                BACKEND_API_ROOT: '/backend/api/v1',
            }
        }
    },
    // what we mean: please, the web-facing stuff here is really just a bunch of static files
    // and also, it's an spa (single-page app), so please just serve its /index.html for anything
    // that does not actually exist as a static asset, and then our SPA JS will figure out what to
    // do with that route
    web: 'static spa=/index.html',
    // also, in this case we think we don't want to deal with CORS and instead just want to refer to the path
    // '/backend/' from our frontend, in a host-relative manner while still talking to our backend
    // so we ask k8s to kindly create ingress rules that will take care of that for us
    proxy: {
        '/backend/': services.backend,
    },
}
```

### Current status

This tool is being developed as part of an effort to materialize my personal experience and knowledge in developing, operating and maintaining server software & services.

I am interested in sponsorship in order to be able to shift more time and focus to this tool's development. If you run or know a company that would benefit greatly from achieving this project's goals faster and more thoroughly, please open an issue and let us know.
