import * as cdk from 'aws-cdk-lib';
import ecs = require('aws-cdk-lib/aws-ecs');
import ec2 = require('aws-cdk-lib/aws-ec2');
import ecr = require('aws-cdk-lib/aws-ecr');
import autoscaling = require('aws-cdk-lib/aws-autoscaling');
import codedeploy = require('aws-cdk-lib/aws-codedeploy');
import elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
import { Construct } from 'constructs';
import { EcsDeployment } from '@cdklabs/cdk-ecs-codedeploy';


interface MyStackProps extends cdk.StackProps {
  vpcId: string,
  instanceType: string,
  minCapacity: number,
  maxCapacity: number,
  codeDeployServiceRoleArn: string,
}


export class EcstestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id, props);

    // grab vpc from id
    const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
      vpcId: props.vpcId,
    });

    // Create ECS cluster
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: vpc,
      clusterName: 'TestCluster',
      defaultCloudMapNamespace: {
        name: 'example.local',
      },
    });

    // Create an AutoScalingGroup
    const ASGsecurityGroup = new ec2.SecurityGroup(this, 'ASGSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    })
    ASGsecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp(), 'Allow all traffic from the LB')
    
    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc,
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      minCapacity: props.minCapacity,
      maxCapacity: props.maxCapacity,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      securityGroup: ASGsecurityGroup,
    });

    const capacityProvider = new ecs.AsgCapacityProvider(this, "AsgCapacityProvider", { autoScalingGroup })
    cluster.addAsgCapacityProvider(capacityProvider);

    autoScalingGroup.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
      cooldown: cdk.Duration.seconds(60)
    });

    // Create a load balancer
    const LBsecurityGroup = new ec2.SecurityGroup(this, 'LBSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    })

    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc: vpc,
      internetFacing: true,
      securityGroup: LBsecurityGroup,
    });

    // Create a listener (Blue/Green to support zero downtime deployments)
    const listenerBlue = lb.addListener('Listener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    listenerBlue.addAction('DefaultAction', {
      action: elbv2.ListenerAction.fixedResponse(404, {
        messageBody: 'Blue'
      })
    });

    const listenerGreen = lb.addListener('ListenerGreen', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    listenerGreen.addAction('DefaultAction', {
      action: elbv2.ListenerAction.fixedResponse(404, {
        messageBody: 'Green'
      })
    });

    // Output load balancer dns name
    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: lb.loadBalancerDnsName });

    // Create the code deploy application
    const codeDeployServiceRole = cdk.aws_iam.Role.fromRoleArn(this, 'CodeDeployServiceRole', props.codeDeployServiceRoleArn);
    const codeDeployApplication = new codedeploy.EcsApplication(this, `${this.stackName}-Application`, {
      applicationName: this.stackName,
    });
  
    // Task definition
    const taskDefinition = new ecs.Ec2TaskDefinition(this, `Test-TaskDef`, {
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    // Add container to task
    // Environment variables are passed to the container
    const container = taskDefinition.addContainer(`Test-Container`, {
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/ecs-sample-image/amazon-ecs-sample:latest"),
      memoryLimitMiB: 256,
    });

    // Add port mapping to container
    container.addPortMappings({
      containerPort: 80,
      protocol: ecs.Protocol.TCP,
    });
    
    // Create a service in ecs
    const service = new ecs.Ec2Service(this, `Test-Service`, {
      cluster,
      taskDefinition,
      desiredCount: 1,
      placementStrategies: [
        ecs.PlacementStrategy.packedBy(ecs.BinPackResource.MEMORY),
        ecs.PlacementStrategy.spreadAcross(ecs.BuiltInAttributes.AVAILABILITY_ZONE)
      ],
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY,
      },
      // Uncomment here
      /*cloudMapOptions: {
        name: "test",
        dnsRecordType: cdk.aws_servicediscovery.DnsRecordType.SRV,
        dnsTtl: cdk.Duration.seconds(10),
      },*/
    });

    // Create Blue/Green target groups
    const targetBlue = new elbv2.ApplicationTargetGroup(this, `Test-TargetBlue`, {
      targets: [service],
      vpc: vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      deregistrationDelay: cdk.Duration.seconds(5),
    });

    const targetGreen = new elbv2.ApplicationTargetGroup(this, `Test-TargetGreen`, {
      targets: [],
      targetType: elbv2.TargetType.INSTANCE,
      vpc: vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      deregistrationDelay: cdk.Duration.seconds(5),
    });

    const applicationListenerRuleBlue = new elbv2.ApplicationListenerRule(this, `Test-ListenerRuleBlue`, {
      listener: listenerBlue,
      priority: 1,

      conditions: [
        elbv2.ListenerCondition.hostHeaders(["test.example.com"]),
      ],
      action: elbv2.ListenerAction.forward([targetBlue])
    });

    const applicationListenerRuleGreen = new elbv2.ApplicationListenerRule(this, `Test-ListenerRuleGreen`, {
      listener: listenerGreen,
      priority: 2,

      conditions: [
        elbv2.ListenerCondition.hostHeaders(["test.example.com"]),
      ],
      action: elbv2.ListenerAction.forward([targetGreen])
    });

    // Create the codedeploy deployment group
    const codeDeployDeploymentGroup = new codedeploy.EcsDeploymentGroup(this, `Test`, {
      service,
      role: codeDeployServiceRole,
      blueGreenDeploymentConfig: {
        blueTargetGroup: targetBlue,
        greenTargetGroup: targetGreen,
        listener: listenerBlue,
        testListener: listenerGreen,
      },
      deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
      application: codeDeployApplication,
    });

    const deployment = new EcsDeployment({
      deploymentGroup: codeDeployDeploymentGroup,
      targetService: {
        taskDefinition: taskDefinition,
        containerName: `Test-Container`,
        containerPort: 80,
      }
    })
  }

}
