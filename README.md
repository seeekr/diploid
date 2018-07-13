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


### Current status

This tool is being developed as part of an effort to materialize my personal experience and knowledge in developing, operating and maintaining server software & services.

I am interested in sponsorship in order to be able to shift more time and focus to this tool's development. If you run or know a company that would benefit greatly from achieving this project's goals faster and more thoroughly, please open an issue and let us know.
